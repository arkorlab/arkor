import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning Node + the bundled CLI bin takes ~600–1200 ms locally; the
    // default 5 s timeout is too tight for assertions that wait for `close`.
    testTimeout: 15_000,
    // ENG-632 retry lives in `spawn-cli.ts` (`runCli` / `shouldRetryAfter
    // Sigkill`), not here. A vitest-level `retry` would rerun on every
    // assertion failure on every platform — too broad. The harness gate
    // only fires when ALL of these hold for the previous attempt:
    //
    //   - `signal === "SIGKILL"`           (the observed runner symptom;
    //                                       SIGTERM/SIGABRT/SIGSEGV are
    //                                       genuine CLI crashes)
    //   - `elapsedMs < SIGKILL_RETRY_MAX_MS` (catches startup kills, not
    //                                       a SIGKILL mid-`pnpm install`
    //                                       where the dirty cwd would
    //                                       make a retry meaningless)
    //   - `process.platform === "darwin"`  (only platform observed)
    //   - `process.env.CI` is set          (local Mac debugging surfaces
    //                                       intermittent crashes one-shot
    //                                       instead of hiding them)
    //
    // See `shouldRetryAfterSigkill` and its tests in `src/spawn-cli.ts`
    // / `src/spawn-cli.test.ts` for the exact decision matrix.
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
