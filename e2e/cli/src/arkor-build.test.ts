import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARKOR_BIN } from "./bins";
import { cleanup, makeTempDir, runCli, type RunResult } from "./spawn-cli";

let cwd: string;

beforeEach(() => {
  cwd = makeTempDir("arkor-build-e2e-");
});

afterEach(() => {
  cleanup(cwd);
});

// Self-contained manifest source so the bundle has no `import` statements
// to resolve at runtime, keeping the e2e test independent of whether `arkor`
// is installed in the temp project.
/**
 * Failure context for clean-exit assertions. `spawn-cli` maps a
 * signal-death close (`code === null`) to `-1`, so a bare
 * `expect(result.code).toBe(0)` failure can't distinguish "exited 1
 * with an error" from "killed by SIGSEGV in native teardown". This
 * suite has flaked on macOS CI with exit -1 and no further signal;
 * surfacing `{ code, signal }` plus stderr in the assertion message
 * identifies the culprit directly in the CI log next time (suspected
 * rolldown native teardown crash; see rolldown/rolldown#9722 for the
 * adjacent worker-thread segfault family).
 */
// A plain throw (rather than vitest's two-arg `expect(value, message)`
// form, which `vitest/valid-expect` rejects) so the failure output
// carries the full context verbatim.
function expectCleanExit(result: RunResult): void {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `expected a clean exit, got code=${result.code} signal=${result.signal ?? "none"}\nstderr:\n${result.stderr}`,
    );
  }
}

const FAKE_MANIFEST = `export const arkor = Object.freeze({
  _kind: "arkor",
  trainer: {
    name: "smoke",
    start: async () => ({ jobId: "j" }),
    wait: async () => ({ job: {}, artifacts: [] }),
    cancel: async () => {},
  },
});
`;

describe("arkor build (E2E)", () => {
  it("bundles src/arkor/index.ts to .arkor/build/index.mjs", async () => {
    mkdirSync(join(cwd, "src/arkor"), { recursive: true });
    writeFileSync(join(cwd, "src/arkor/index.ts"), FAKE_MANIFEST);

    const result = await runCli(ARKOR_BIN, ["build"], cwd);
    expectCleanExit(result);

    const outFile = join(cwd, ".arkor/build/index.mjs");
    expect(existsSync(outFile)).toBe(true);
    const content = readFileSync(outFile, "utf8");
    // Manifest brand and trainer name survive bundling.
    expect(content).toContain("_kind");
    expect(content).toContain('"arkor"');
    expect(content).toContain('"smoke"');
  });

  it("bundles a custom entry when one is passed positionally", async () => {
    writeFileSync(join(cwd, "custom.ts"), FAKE_MANIFEST);

    const result = await runCli(ARKOR_BIN, ["build", "custom.ts"], cwd);
    expectCleanExit(result);
    expect(existsSync(join(cwd, ".arkor/build/index.mjs"))).toBe(true);
  });

  it("fails with a clear error when no entry exists", async () => {
    const result = await runCli(ARKOR_BIN, ["build"], cwd);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Build entry not found/);
  });

  // Regression for the redesign: a freshly init'd project must build out of
  // the box. Catches drift between the scaffold output and what `arkor build`
  // expects on disk (e.g. if templates ever stop exporting `arkor`).
  it("builds a freshly init'd project end-to-end", async () => {
    const initResult = await runCli(
      ARKOR_BIN,
      ["init", "-y", "--skip-install", "--skip-git"],
      cwd,
    );
    expectCleanExit(initResult);

    const buildResult = await runCli(ARKOR_BIN, ["build"], cwd);
    expectCleanExit(buildResult);
    expect(existsSync(join(cwd, ".arkor/build/index.mjs"))).toBe(true);
  });
});
