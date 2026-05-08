import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default stays node so existing logic suites
    // (`route.test.ts`, `lib/theme.test.ts`) keep exercising their
    // `typeof window === "undefined"` branches honestly. Component
    // tests opt into jsdom per-file with `// @vitest-environment jsdom`
    // at the top of each `*.test.tsx`.
    setupFiles: ["./vitest.setup.ts"],
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
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/styles.css",
        "src/test-utils/**",
      ],
    },
  },
});
