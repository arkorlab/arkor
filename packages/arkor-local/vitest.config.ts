import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The runner/server suites spawn real child processes (fake trainers,
    // SSE streams with grace periods); vitest's 5s default flakes on slow
    // CI runners, so give every test the same generous ceiling.
    testTimeout: 20_000,
    // `default` keeps normal CLI output; `junit` writes the XML that
    // codecov/codecov-action (with `report_type: test_results`) consumes
    // for Test Analytics.
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "cobertura"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
