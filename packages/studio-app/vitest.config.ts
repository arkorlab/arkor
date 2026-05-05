import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom so component tests can render React trees, and so `api.ts`'s
    // module-level `document.querySelector('meta[name="arkor-studio-token"]')`
    // sees the CSRF token that `vitest.setup.ts` injects.
    environment: "jsdom",
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
