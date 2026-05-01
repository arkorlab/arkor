import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `default` keeps normal CLI output; `junit` writes the XML that
    // codecov/codecov-action (with `report_type: test_results`) consumes
    // for Test Analytics.
    reporters: ["default", "junit"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
