import { describe, expect, it } from "vitest";
import { shouldRetryAfterSigkill, type RunResult } from "./spawn-cli";

// Pure-function tests for the ENG-632 retry gate. They cover the decision
// matrix exhaustively so a future refactor that accidentally widens or
// narrows the gate (e.g. forgets the `process.env.CI` check, drops the
// elapsed-ms cutoff, treats SIGTERM as kill-equivalent) trips a unit test
// rather than silently changing CI flake-tolerance behaviour.
//
// We deliberately keep this at the pure-function level: mocking
// `node:child_process` end-to-end would buy us little extra coverage
// because the wiring in `runCli` is just `if (gate(result, …)) retry`.

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
    // SIGKILL after ~1.5 s most likely landed mid-run (during
    // `pnpm install`, after `git init`, etc.) — the dirty `cwd` from
    // attempt 1 would either mask the real failure or produce a different
    // failure on retry. The 1500 ms cutoff is calibrated against the
    // observed flake (~100 ms) with a 10× safety margin.
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal: "SIGKILL", elapsedMs: 1500 }),
        "darwin",
        true,
      ),
    ).toBe(false);
    expect(
      shouldRetryAfterSigkill(
        makeResult({ signal: "SIGKILL", elapsedMs: 5000 }),
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
