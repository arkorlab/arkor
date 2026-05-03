import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `vi.hoisted` ensures the mock factory and its captured `spawnMock` are
// available before any module-level imports execute, so the
// `import { spawn } from "node:child_process"` at the top of `spawn-cli.ts`
// resolves to our fake instead of the real Node binding.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Imports come after the `vi.mock` for clarity; vitest hoists both above
// the imports at runtime so the mocked binding is in place either way.
// eslint-disable-next-line import/first
import { runCli, shouldRetryAfterSigkill, type RunResult } from "./spawn-cli";

// Pure-function tests for the ENG-632 retry gate. They cover the decision
// matrix exhaustively so a future refactor that accidentally widens or
// narrows the gate (e.g. forgets the `process.env.CI` check, drops the
// elapsed-ms cutoff, treats SIGTERM as kill-equivalent) trips a unit test
// rather than silently changing CI flake-tolerance behaviour.

function makeResult(overrides: Partial<RunResult>): RunResult {
  return {
    code: 0,
    signal: null,
    elapsedMs: 100,
    stdout: "",
    stderr: "",
    dir: "/tmp/x",
    ...overrides,
  };
}

describe("shouldRetryAfterSigkill", () => {
  it("retries the canonical GitHub macOS startup-SIGKILL flake", () => {
    // Exactly the PR #104 symptom: macOS runner, CI=1, child SIGKILL'd
    // at ~100 ms during the bin's startup re-exec.
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal: "SIGKILL", elapsedMs: 104 }),
        "darwin",
        true,
      ),
    ).toBe(true);
  });

  it.each<NodeJS.Signals>([
    "SIGTERM",
    "SIGABRT",
    "SIGSEGV",
    "SIGBUS",
    "SIGINT",
  ])("does not retry on %s — those are genuine CLI crashes", (signal) => {
    // Anything other than SIGKILL means the CLI itself faulted
    // (assertion failure, OOM-but-not-from-runner, segfault, user ^C).
    // Retrying would mask the real bug.
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal, elapsedMs: 100 }),
        "darwin",
        true,
      ),
    ).toBe(false);
  });

  it("does not retry on a clean non-zero exit", () => {
    // Deterministic CLI failure (e.g. `--git --skip-git` argument clash,
    // assertion-driven test failure). Must surface on the first attempt.
    expect(
      shouldRetryAfterSigkill(
        makeResult({ code: 1, signal: null, elapsedMs: 100 }),
        "darwin",
        true,
      ),
    ).toBe(false);
  });

  it("does not retry on a clean exit-zero", () => {
    // The happy-path baseline — the gate must not fire when the test
    // passed. Sanity check; a buggy gate that returned `true` here would
    // double the runtime of every test for no reason.
    expect(
      shouldRetryAfterSigkill(makeResult({ elapsedMs: 100 }), "darwin", true),
    ).toBe(false);
  });

  it("does not retry once the elapsed-ms cutoff is exceeded", () => {
    // The cutoff is held below the time scaffold needs to start writing
    // files (clean `arkor init --skip-install --skip-git` lands at
    // ~600–1200 ms; see `vitest.config.ts`'s `testTimeout` rationale), so
    // a SIGKILL above that cutoff most likely landed *after* the bin
    // touched the filesystem. The dirty `cwd` from attempt 1 could then
    // either mask a real failure or produce a different failure on
    // attempt 2 — both worse outcomes than just letting the SIGKILL
    // surface as-is.
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal: "SIGKILL", elapsedMs: 300 }),
        "darwin",
        true,
      ),
    ).toBe(false);
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal: "SIGKILL", elapsedMs: 800 }),
        "darwin",
        true,
      ),
    ).toBe(false);
  });

  it.each<NodeJS.Platform>(["linux", "win32", "freebsd"])(
    "does not retry on %s — only the macOS runner has produced the symptom",
    (platform) => {
      // Other platforms have not exhibited this flake on PR #104's CI
      // history; widening the gate would let a real Linux/Windows
      // regression need two failures before surfacing.
      expect(
        shouldRetryAfterSigkill(
          makeResult({ signal: "SIGKILL", elapsedMs: 100 }),
          platform,
          true,
        ),
      ).toBe(false);
    },
  );

  it("does not retry when CI is unset (local debugging)", () => {
    // A developer chasing an intermittent crash on a Mac dev machine
    // wants the failure to surface immediately, not be silently retried
    // and possibly reported as flaky. Gating on `process.env.CI`
    // restricts the retry to the runner where we actually need it.
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal: "SIGKILL", elapsedMs: 100 }),
        "darwin",
        false,
      ),
    ).toBe(false);
  });
});

// `runCli` orchestration tests: hermetic, mock `node:child_process` so
// we can drive the close-event sequence and assert on call count. The
// pure-function tests above lock in the gate's decision matrix; these
// tests lock in that `runCli` actually wires the gate up correctly —
// retries exactly once (not zero, not twice) on a qualifying SIGKILL,
// wipes `cwd` between attempts, refuses to retry against pre-seeded
// state, and never retries non-qualifying outcomes.

interface FakeCloseSpec {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function makeFakeChild(close: FakeCloseSpec): EventEmitter {
  // Vitest's mock of `node:child_process.spawn` returns this fake.
  // We only emit the events `runCliOnce` listens for: `close` carries
  // the (code, signal) tuple, and the `stdout`/`stderr` sub-emitters
  // never fire any data (the test isn't asserting on captured output).
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  // Defer the close emit so the caller has a chance to attach its
  // listener inside the Promise constructor before we fire.
  setImmediate(() => {
    child.emit("close", close.code, close.signal);
  });
  return child;
}

describe("runCli orchestration", () => {
  // Pin the platform / CI to the canonical "we should retry" environment
  // so the gate can fire when the close-spec qualifies. Individual tests
  // override the close spec (and `Date.now` returns) to vary the outcome.
  const ORIG_PLATFORM = process.platform;
  const ORIG_CI = process.env.CI;
  let cwd: string;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    process.env.CI = "1";
    spawnMock.mockReset();
    // Real temp dir so the cwd-empty / wipe / pre-seed paths actually
    // exercise filesystem state. The mocked `spawn` doesn't run a real
    // process, so any files in `cwd` come from `writeFileSync` inside
    // the test or inside the mock's `mockImplementationOnce` callback —
    // i.e. exactly the carryover patterns we want to assert on.
    cwd = mkdtempSync(join(tmpdir(), "spawn-cli-orchestration-"));
    // Pin `Date.now` so `elapsedMs` is independent of wall-clock jitter.
    // CI runners under load can delay `setImmediate` past the 300 ms
    // gate; this stub keeps the test deterministic regardless. Each
    // test overrides the return queue to simulate the elapsed time it
    // wants attempt 1 (and, if applicable, attempt 2) to look like.
    dateNowSpy = vi.spyOn(Date, "now");
    // Suppress + capture the retry log so it doesn't pollute test
    // output and so we can assert it fired.
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      .mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: ORIG_PLATFORM,
      configurable: true,
    });
    if (ORIG_CI === undefined) delete process.env.CI;
    else process.env.CI = ORIG_CI;
    rmSync(cwd, { recursive: true, force: true });
    dateNowSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("retries exactly once when a qualifying SIGKILL precedes a clean exit", async () => {
    // The canonical recovery path: attempt 1 SIGKILL'd at 100 ms (under
    // the 300 ms cutoff), attempt 2 clean. `spawnMock` should be called
    // twice and the final result reflects attempt 2's exit.
    dateNowSpy
      .mockReturnValueOnce(1000) // attempt 1 start
      .mockReturnValueOnce(1100) // attempt 1 close → elapsedMs=100
      .mockReturnValueOnce(2000) // attempt 2 start
      .mockReturnValueOnce(2050); // attempt 2 close → elapsedMs=50
    spawnMock
      .mockImplementationOnce(() => makeFakeChild({ code: null, signal: "SIGKILL" }))
      .mockImplementationOnce(() => makeFakeChild({ code: 0, signal: null }));

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.elapsedMs).toBe(50);
    // Retry was logged so CI inspection can see how often this fires.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("retrying after SIGKILL at 100ms"),
    );
  });

  it("does not retry a third time when both attempts SIGKILL", async () => {
    // Retry budget is one — a second SIGKILL must surface as the final
    // result. Without this guard a flaky environment could loop forever.
    dateNowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2100);
    spawnMock
      .mockImplementationOnce(() => makeFakeChild({ code: null, signal: "SIGKILL" }))
      .mockImplementationOnce(() => makeFakeChild({ code: null, signal: "SIGKILL" }));

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.signal).toBe("SIGKILL");
  });

  it("does not retry a non-qualifying signal (SIGTERM)", async () => {
    // SIGTERM is *not* the runner-flake signature; retrying would risk
    // hiding a genuine crash. Spawn must be invoked exactly once.
    dateNowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1100);
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: null, signal: "SIGTERM" }),
    );

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.signal).toBe("SIGTERM");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not retry a clean exit", async () => {
    // The hot-path sanity check: a green test run must not double the
    // spawn cost. If the gate ever returned `true` for a clean exit
    // every CI run would silently re-execute every test once.
    dateNowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: 0, signal: null }),
    );

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not retry once SIGKILL elapsed-ms exceeds the cutoff", async () => {
    // Wall-clock 500 ms attempt 1: well past `SIGKILL_RETRY_MAX_MS`.
    // Same SIGKILL signature as the canonical flake but the elapsed
    // time signals it landed mid-run, so the gate refuses.
    dateNowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: null, signal: "SIGKILL" }),
    );

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.signal).toBe("SIGKILL");
    expect(result.elapsedMs).toBe(500);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not retry when `cwd` was non-empty before attempt 1", async () => {
    // Some tests pre-seed `cwd` with state the CLI is supposed to react
    // to (e.g. `arkor init` against a directory that already has
    // `git init` run inside it). Wiping that state to retry would
    // change the CLI's input, so the gate suppresses the retry and
    // surfaces the SIGKILL directly.
    writeFileSync(join(cwd, "preseeded"), "");
    dateNowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1100);
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: null, signal: "SIGKILL" }),
    );

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.signal).toBe("SIGKILL");
    // Pre-seeded file survived (the wipe path was skipped).
    expect(existsSync(join(cwd, "preseeded"))).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("wipes leftover scaffold artefacts before attempt 2", async () => {
    // Simulate the precise concern reviewers flagged: a SIGKILL that
    // landed *during* scaffold's filesystem writes leaves a partially
    // populated `cwd`. The mock's first implementation writes a
    // sentinel to fake that partial scaffold; attempt 2 must run
    // against an empty `cwd` so it can scaffold fresh.
    dateNowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2050);
    spawnMock
      .mockImplementationOnce(() => {
        writeFileSync(join(cwd, "package.json"), "{ partial }");
        writeFileSync(join(cwd, "README.md"), "partial");
        return makeFakeChild({ code: null, signal: "SIGKILL" });
      })
      .mockImplementationOnce(() => {
        // Attempt 2 runs against a wiped `cwd` — exactly what a single
        // clean run would have seen.
        expect(readdirSync(cwd)).toEqual([]);
        return makeFakeChild({ code: 0, signal: null });
      });

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(0);
  });
});
