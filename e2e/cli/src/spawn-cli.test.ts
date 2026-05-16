import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("restores pre-seeded `cwd` state across the retry while clearing scaffold leftovers", async () => {
    // Tests that pre-seed `cwd` (e.g. `arkor-init.test.ts`'s
    // `git init` setup, `arkor-whoami.test.ts`'s seeded credentials,
    // build fixtures) need the retry to leave their pre-seed state
    // exactly as they wrote it. The full content snapshot guarantees
    // that: pre-existing files survive, anything attempt 1 added gets
    // removed before attempt 2 spawns.
    //
    // Setup: pre-seed `cwd/.git/HEAD` (a small file inside an existing
    // dir, mirroring `git init`'s output) plus a sibling marker file.
    // The killed first attempt then fakes a partial scaffold by
    // writing `package.json` *and* a new file inside the pre-existing
    // `.git/` (e.g. `.git/index`). Attempt 2 should see only the
    // pre-seeded paths, with the partial scaffold gone.
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(cwd, "preseeded.txt"), "user state");

    dateNowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2050);
    spawnMock
      .mockImplementationOnce(() => {
        // Fake a partial scaffold: a brand-new top-level file *and* a
        // new file inside the pre-seeded `.git/` directory. Both should
        // be cleared on retry.
        writeFileSync(join(cwd, "package.json"), "{ partial }");
        writeFileSync(join(cwd, ".git", "index"), "binary blob");
        return makeFakeChild({ code: null, signal: "SIGKILL" });
      })
      .mockImplementationOnce(() => {
        // Attempt 2 sees only the pre-seeded baseline.
        expect(existsSync(join(cwd, ".git", "HEAD"))).toBe(true);
        expect(readFileSync(join(cwd, "preseeded.txt"), "utf8")).toBe(
          "user state",
        );
        // Attempt 1's new files were removed.
        expect(existsSync(join(cwd, "package.json"))).toBe(false);
        expect(existsSync(join(cwd, ".git", "index"))).toBe(false);
        return makeFakeChild({ code: 0, signal: null });
      });

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("retrying after SIGKILL at 100ms"),
    );
  });

  it("restores pre-existing files that attempt 1 modified in place", async () => {
    // The harder snapshot case: attempt 1 doesn't add a new file, it
    // *overwrites* a pre-existing one (e.g. `arkor build` rewriting an
    // already-present `.arkor/build/index.mjs`). A path-set snapshot
    // would carry the mutated baseline file into attempt 2 and let a
    // failure pass spuriously; the full content snapshot puts the
    // original bytes back so attempt 2 sees the same input attempt 1
    // had.
    mkdirSync(join(cwd, ".arkor", "build"), { recursive: true });
    writeFileSync(
      join(cwd, ".arkor", "build", "index.mjs"),
      "// pre-existing build output\n",
    );

    dateNowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2050);
    spawnMock
      .mockImplementationOnce(() => {
        // Fake an in-place rewrite (no new path, just changed content).
        writeFileSync(
          join(cwd, ".arkor", "build", "index.mjs"),
          "// truncated rewrite from attempt 1\n",
        );
        return makeFakeChild({ code: null, signal: "SIGKILL" });
      })
      .mockImplementationOnce(() => {
        // Attempt 2 sees the original bytes, not the truncated rewrite.
        expect(
          readFileSync(join(cwd, ".arkor", "build", "index.mjs"), "utf8"),
        ).toBe("// pre-existing build output\n");
        return makeFakeChild({ code: 0, signal: null });
      });

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(0);
  });

  it("wipes leftover scaffold artefacts when `cwd` started empty", async () => {
    // Simpler case of the same restore: empty cwd at attempt 1 start,
    // partial scaffold from the SIGKILL'd attempt, attempt 2 sees an
    // empty cwd again. This is the canonical PR #104 pattern.
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
        expect(readdirSync(cwd)).toEqual([]);
        return makeFakeChild({ code: 0, signal: null });
      });

    const result = await runCli("/fake/bin", [], cwd);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(0);
  });
});

// Per-spawn yarn cache plumbing: the matrix's yarn-flake fix
// depends on `YARN_CACHE_FOLDER` being a fresh tmp dir per call
// (so parallel vitest workers don't race the shared
// `~/.cache/yarn/v6/`), `YARN_NETWORK_CONCURRENCY=1` being
// forwarded (yarn 1 optional-deps extraction race), the temp
// cache being cleaned up on either close or error (no tmpdir
// pollution), and `extraEnv` keeping its last-write-wins ordering
// (so individual tests can override). Round 28 (Copilot, PR #99)
// flagged the absence of hermetic coverage for this plumbing —
// these tests lock the contract down so a future refactor that
// drops a piece trips a unit test rather than a CI yarn flake.
describe("runCli yarn cache plumbing", () => {
  let cwd: string;

  beforeEach(() => {
    spawnMock.mockReset();
    cwd = mkdtempSync(join(tmpdir(), "spawn-cli-yarn-plumbing-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function lastSpawnEnv(): NodeJS.ProcessEnv {
    const calls = spawnMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[calls.length - 1]?.[2] as { env: NodeJS.ProcessEnv };
    return opts.env;
  }

  it("forwards YARN_CACHE_FOLDER pointing at a fresh tmp dir per spawn", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: 0, signal: null }),
    );
    await runCli("/fake/bin", [], cwd);

    const yarnCache = lastSpawnEnv().YARN_CACHE_FOLDER;
    expect(yarnCache).toBeDefined();
    // mkdtempSync places it under tmpdir() with our prefix.
    expect(yarnCache).toMatch(/[\\/]arkor-e2e-yarn-cache-/);
  });

  it("forwards YARN_NETWORK_CONCURRENCY=1 (yarn 1 optionalDeps extraction race)", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: 0, signal: null }),
    );
    await runCli("/fake/bin", [], cwd);

    expect(lastSpawnEnv().YARN_NETWORK_CONCURRENCY).toBe("1");
  });

  // Round 36 (PR #99 — CI run 25349847532): bun on Windows
  // raced its shared `~/.bun/install/cache/` between vitest
  // workers, the rename of `.<hash>-<n>.<pkg>` →
  // `<pkg>@<ver>@@@<n>` failed with `ENOTEMPTY
  // (NtSetInformationFile)` and the install bailed with
  // `error: InstallFailed extracting tarball from <pkg>`.
  // Per-spawn `BUN_INSTALL_CACHE_DIR` mirrors the yarn fix.
  it("forwards BUN_INSTALL_CACHE_DIR pointing at a fresh tmp dir per spawn", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: 0, signal: null }),
    );
    await runCli("/fake/bin", [], cwd);

    const bunCache = lastSpawnEnv().BUN_INSTALL_CACHE_DIR;
    expect(bunCache).toBeDefined();
    expect(bunCache).toMatch(/[\\/]arkor-e2e-bun-cache-/);
  });

  // Round 36 (PR #99 — CI run 25351227697): yarn-berry on
  // Windows raced its global `%LOCALAPPDATA%\Yarn\Berry\cache`
  // between workers and tarball renames failed with `EPERM:
  // operation not permitted`. yarn-berry only honours
  // `YARN_CACHE_FOLDER` when its global cache is disabled, so
  // we force `YARN_ENABLE_GLOBAL_CACHE=false` to redirect into
  // the per-spawn cache dir.
  it("forwards YARN_ENABLE_GLOBAL_CACHE=false so yarn-berry honours YARN_CACHE_FOLDER", async () => {
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: 0, signal: null }),
    );
    await runCli("/fake/bin", [], cwd);

    expect(lastSpawnEnv().YARN_ENABLE_GLOBAL_CACHE).toBe("false");
  });

  it("uses a unique YARN_CACHE_FOLDER for each spawn (covers the retry case)", async () => {
    // Force a SIGKILL retry so spawn fires twice; assert the two
    // cache dirs are distinct paths (otherwise parallel workers
    // would still race the same dir on the retry path).
    //
    // Round 29 (Copilot, PR #99): the original `finally` here
    // captured `process.platform` AFTER mutating it to "darwin",
    // so the restore was a no-op and the fake platform leaked
    // into later tests in this file. Snapshot the descriptor
    // (or just the original value) BEFORE the mutation and
    // restore from that.
    const originalPlatform = process.platform;
    const originalCI = process.env.CI;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    process.env.CI = "1";
    try {
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1100)
        .mockReturnValueOnce(2000)
        .mockReturnValueOnce(2050);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        spawnMock
          .mockImplementationOnce(() =>
            makeFakeChild({ code: null, signal: "SIGKILL" }),
          )
          .mockImplementationOnce(() =>
            makeFakeChild({ code: 0, signal: null }),
          );

        await runCli("/fake/bin", [], cwd);

        expect(spawnMock).toHaveBeenCalledTimes(2);
        const firstEnv = (
          spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }
        ).env;
        const secondEnv = (
          spawnMock.mock.calls[1]?.[2] as { env: NodeJS.ProcessEnv }
        ).env;
        expect(firstEnv.YARN_CACHE_FOLDER).toBeDefined();
        expect(secondEnv.YARN_CACHE_FOLDER).toBeDefined();
        expect(firstEnv.YARN_CACHE_FOLDER).not.toBe(
          secondEnv.YARN_CACHE_FOLDER,
        );
      } finally {
        dateNowSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    } finally {
      // Restore both the platform AND the CI env so this test's
      // mutations don't leak into subsequent tests in the file.
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      if (originalCI === undefined) delete process.env.CI;
      else process.env.CI = originalCI;
    }
  });

  it("cleans up the yarn AND bun cache dirs after a clean close", async () => {
    let capturedYarnCacheDir: string | undefined;
    let capturedBunCacheDir: string | undefined;
    spawnMock.mockImplementationOnce((_execPath, _argv, opts) => {
      const env = (opts as { env: NodeJS.ProcessEnv }).env;
      capturedYarnCacheDir = env.YARN_CACHE_FOLDER;
      capturedBunCacheDir = env.BUN_INSTALL_CACHE_DIR;
      // Inside the spawn impl both dirs are freshly mkdtemp'd
      // by the caller, so they should exist at this point.
      expect(capturedYarnCacheDir).toBeDefined();
      expect(capturedBunCacheDir).toBeDefined();
      expect(existsSync(capturedYarnCacheDir!)).toBe(true);
      expect(existsSync(capturedBunCacheDir!)).toBe(true);
      return makeFakeChild({ code: 0, signal: null });
    });

    await runCli("/fake/bin", [], cwd);

    // After runCli resolves, the close handler's cleanup should
    // have removed both dirs — no tmpdir pollution.
    expect(existsSync(capturedYarnCacheDir!)).toBe(false);
    expect(existsSync(capturedBunCacheDir!)).toBe(false);
  });

  // Round 39 (Copilot, PR #99): the per-spawn cache dirs were
  // mkdtemp'd before `spawn(...)` was called, so a SYNCHRONOUS
  // spawn throw (invalid `binPath`, exec-time platform error,
  // EACCES on the cwd, etc.) leaked them — the close/error
  // listeners that fire `cleanup()` never got a chance to
  // attach. The fix wraps `spawn` in a try/catch and runs the
  // same teardown before propagating. Without this, a tight
  // loop of failed spawns fills tmpdir on long CI runs.
  it("cleans up the yarn AND bun cache dirs when spawn() throws synchronously", async () => {
    // Capture the env spawn() would have received so the test
    // can read the cache-dir paths back even though spawn never
    // returns a child. We do this by stashing the env on the
    // first call and then throwing.
    let capturedYarnCacheDir: string | undefined;
    let capturedBunCacheDir: string | undefined;
    spawnMock.mockImplementationOnce((_execPath, _argv, opts) => {
      const env = (opts as { env: NodeJS.ProcessEnv }).env;
      capturedYarnCacheDir = env.YARN_CACHE_FOLDER;
      capturedBunCacheDir = env.BUN_INSTALL_CACHE_DIR;
      throw new Error("spawn EACCES (synthetic)");
    });

    await expect(runCli("/fake/bin", [], cwd)).rejects.toThrow(
      /spawn EACCES/,
    );
    expect(capturedYarnCacheDir).toBeDefined();
    expect(capturedBunCacheDir).toBeDefined();
    // Both dirs must be gone — without the try/catch around
    // spawn(), the unhandled throw would leak them.
    expect(existsSync(capturedYarnCacheDir!)).toBe(false);
    expect(existsSync(capturedBunCacheDir!)).toBe(false);
  });

  it("cleans up the yarn AND bun cache dirs even when the child emits `error`", async () => {
    let capturedYarnCacheDir: string | undefined;
    let capturedBunCacheDir: string | undefined;
    spawnMock.mockImplementationOnce((_execPath, _argv, opts) => {
      const env = (opts as { env: NodeJS.ProcessEnv }).env;
      capturedYarnCacheDir = env.YARN_CACHE_FOLDER;
      capturedBunCacheDir = env.BUN_INSTALL_CACHE_DIR;
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      // Defer the error emit so the caller has a chance to attach
      // its listener inside the Promise constructor before we fire.
      setImmediate(() => {
        child.emit("error", new Error("spawn ENOENT"));
      });
      return child;
    });

    await expect(runCli("/fake/bin", [], cwd)).rejects.toThrow(
      /spawn ENOENT/,
    );
    // Error path also has to clean — otherwise a tight loop of
    // failed spawns would fill tmpdir on long CI runs.
    expect(capturedYarnCacheDir).toBeDefined();
    expect(capturedBunCacheDir).toBeDefined();
    expect(existsSync(capturedYarnCacheDir!)).toBe(false);
    expect(existsSync(capturedBunCacheDir!)).toBe(false);
  });

  it("lets extraEnv last-write-wins override YARN_CACHE_FOLDER", async () => {
    // Tests that genuinely need a stable / pre-populated cache
    // (e.g. an integration test seeding offline yarn artefacts)
    // can override via extraEnv. The default-then-extraEnv spread
    // ordering inside spawn-cli.ts puts extraEnv last so the
    // override wins.
    spawnMock.mockImplementationOnce(() =>
      makeFakeChild({ code: 0, signal: null }),
    );
    await runCli("/fake/bin", [], cwd, {
      YARN_CACHE_FOLDER: "/explicitly/overridden",
    });

    expect(lastSpawnEnv().YARN_CACHE_FOLDER).toBe("/explicitly/overridden");
  });

  it("strips npm_config_* / pnpm_config_* leakage from the parent shell", async () => {
    // pnpm propagates its workspace config to children as
    // `npm_config_*` env vars. If those leak through, scaffolded
    // fixtures inherit the workspace's policy (most painfully
    // `minimumReleaseAge`, which blocks freshly-published `arkor`
    // versions). The runCli wrapper strips them; this test pins
    // that contract by setting a leaky var on the parent and
    // asserting it doesn't reach the child env.
    const ORIG = process.env.npm_config_minimum_release_age;
    process.env.npm_config_minimum_release_age = "1440";
    try {
      spawnMock.mockImplementationOnce(() =>
        makeFakeChild({ code: 0, signal: null }),
      );
      await runCli("/fake/bin", [], cwd);

      expect(lastSpawnEnv().npm_config_minimum_release_age).toBeUndefined();
    } finally {
      if (ORIG === undefined) delete process.env.npm_config_minimum_release_age;
      else process.env.npm_config_minimum_release_age = ORIG;
    }
  });
});
