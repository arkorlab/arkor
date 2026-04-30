import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning Node + the bundled CLI bin takes ~600–1200 ms locally; the
    // default 5 s timeout is too tight for assertions that wait for `close`.
    testTimeout: 15_000,
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
