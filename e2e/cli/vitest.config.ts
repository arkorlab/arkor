import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning Node + the bundled CLI bin takes ~600–1200 ms locally; the
    // default 5 s timeout is too tight for assertions that wait for `close`.
    testTimeout: 15_000,
    // ENG-632: every e2e case spawns `dist/bin.mjs` as a Node child and
    // captures its stdio via spawn-cli.ts. macOS GitHub runners
    // occasionally signal-kill that child during startup under load (the
    // child's `close` event fires with `code === null`, which spawn-cli
    // surfaces as `result.code === -1` and trips assertions like
    // `expect(result.code).toBe(0)`). Same test passes on rerun and on
    // every other matrix slot — runner artefact, not a regression.
    //
    // Gate the retry on `darwin` only: the SIGKILL pattern has only ever
    // been observed on macOS runners, and applying retry universally
    // would let a real Linux/Windows regression need three failures
    // before it surfaces — and would slow local debugging on those
    // platforms. Mac developers debugging locally see the same retry as
    // CI, which is acceptable because the flake symptom (`code === -1`
    // with no other output) is unmistakable in vitest's `(retry x N)`
    // annotation. Unit suites under `packages/*` are unaffected — they
    // load their own vitest config without `retry`.
    retry: process.platform === "darwin" ? 2 : 0,
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
