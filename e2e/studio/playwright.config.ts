import { defineConfig, devices } from "@playwright/test";

// Each test boots its own `arkor dev` subprocess + fake cloud-api on
// ephemeral ports, so a Playwright `webServer` block is not used; the
// per-test fixture in `src/harness/fixture.ts` owns lifecycle. Workers
// stay at 1 to keep port allocation, child-process supervision, and
// stdout tailing simple — parallelism is a future optimisation.
export default defineConfig({
  testDir: "./src/specs",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  // Spawning `arkor dev` (~600–1500 ms) + Chromium (~500–2000 ms) plus
  // the test body easily exceeds the default 30s on slower CI runners.
  // 60s leaves headroom without hiding genuine hangs.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  // `list` keeps the human-readable progress; `junit` writes the XML
  // that codecov-action consumes for Test Analytics — same pattern as
  // e2e/cli's vitest config.
  reporter: [
    ["list"],
    ["junit", { outputFile: "coverage/junit.xml" }],
    ["html", { open: "never" }],
  ],
  use: {
    baseURL: undefined, // each test reads `studio.url` from the fixture
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Chromium only on purpose: Studio is a localhost-only React 19 SPA
    // with stock fetch / EventSource. WebKit / Firefox would triple CI
    // time without surfacing meaningful regressions.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
