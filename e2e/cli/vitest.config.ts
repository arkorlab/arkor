import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning Node + the bundled CLI bin takes ~600–1200 ms locally; the
    // default 5 s timeout is too tight for assertions that wait for `close`.
    testTimeout: 15_000,
    // ENG-632 retry lives in `spawn-cli.ts` (`runCli`) instead of here:
    // vitest's test-level retry would re-run on *any* assertion failure,
    // masking deterministic regressions on macOS for an extra attempt.
    // The harness-level retry only fires on `result.code === -1` (child
    // closed with `code === null`, i.e. signal-killed before a proper
    // exit), which is the exact GitHub macOS-runner symptom we saw on
    // PR #104. Real non-zero exits are not retried.
    // `default` keeps normal CLI output; `junit` writes the XML that
    // codecov-action consumes for Test Analytics. E2E coverage itself is
    // collected via c8 (NODE_V8_COVERAGE) wrapping vitest in the
    // `test:coverage` script — vitest's own coverage option is not used
    // here because v8 coverage of *child* CLI processes is what we want.
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
  },
});
