import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawning Node + the bundled CLI bin takes ~600–1200 ms locally; the
    // default 5 s timeout is too tight for assertions that wait for `close`.
    testTimeout: 15_000,
  },
});
