import { test as base } from "@playwright/test";
import { startFakeCloudApi, type CloudApiMock } from "./cloudApiMock";
import { cleanup, createFixture, type FixturePaths } from "./seedFixture";
import { startStudio, type StudioHandle } from "./studioServer";

interface StudioFixtures {
  /** Live `arkor dev` instance for this test (URL + CSRF token). */
  studio: StudioHandle;
  /** In-process fake cloud-api the Studio server proxies through. */
  cloudApi: CloudApiMock;
  /** tmp HOME + project dir, cleaned up automatically. */
  fixturePaths: FixturePaths;
}

/**
 * Per-test boot/teardown of the full E2E stack: fake cloud-api →
 * seeded fixture (HOME + project) → spawned `arkor dev`. Each test
 * gets its own ephemeral ports, so workers can in principle parallelise
 * later without code changes (we keep `workers: 1` in the Playwright
 * config for now to keep child supervision simple).
 *
 * The fixtures wire up so the test body can do:
 *
 *   test("…", async ({ page, studio, cloudApi }) => {
 *     await page.goto(studio.url);
 *     cloudApi.setRoute("GET", "/v1/jobs", (req, res) => { … });
 *     // …
 *   });
 */
export const test = base.extend<StudioFixtures>({
  cloudApi: async ({}, use) => {
    const api = await startFakeCloudApi();
    try {
      await use(api);
    } finally {
      await api.close();
    }
  },
  fixturePaths: async ({ cloudApi }, use) => {
    const paths = createFixture(cloudApi.baseUrl);
    try {
      await use(paths);
    } finally {
      cleanup(paths.home);
      cleanup(paths.projectDir);
    }
  },
  studio: async ({ cloudApi, fixturePaths }, use) => {
    const studio = await startStudio({
      home: fixturePaths.home,
      projectDir: fixturePaths.projectDir,
      cloudApiUrl: cloudApi.baseUrl,
    });
    try {
      await use(studio);
    } finally {
      await studio.kill();
    }
  },
});

export { expect } from "@playwright/test";
