import { expect, test } from "@playwright/test";

import { cleanup } from "../harness/seedFixture";
import { createLocalFixture } from "../harness/localFixture";
import { startStudio } from "../harness/studioServer";

import type { LocalFixturePaths } from "../harness/localFixture";
import type { StudioHandle } from "../harness/studioServer";

/**
 * Browser-layer E2E for `arkor dev --local`.
 *
 * Gated to Apple Silicon macOS: the MLX backend's preflight (darwin +
 * arm64) runs for real, with only `uv` faked (see localFixture.ts). Runs
 * on CI's macos (arm64) matrix leg, skips elsewhere.
 *
 * The cloud-api URL is pinned to an unroutable port on purpose: any
 * Studio route that still reached for the cloud in local mode would fail
 * loudly instead of silently passing against a mock.
 */
const APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64";

const UNREACHABLE_CLOUD = "http://127.0.0.1:9";

test.describe("arkor dev --local", () => {
  test.skip(!APPLE_SILICON, "requires Apple Silicon macOS (MLX preflight)");

  let paths: LocalFixturePaths;
  let studio: StudioHandle;

  test.beforeEach(async () => {
    paths = createLocalFixture();
    studio = await startStudio({
      home: paths.home,
      projectDir: paths.projectDir,
      cloudApiUrl: UNREACHABLE_CLOUD,
      extraArgs: ["--local"],
      extraEnv: {
        PATH: `${paths.fakeUvBinDir}:${process.env.PATH ?? ""}`,
      },
    });
  });

  test.afterEach(async () => {
    await studio.kill();
    cleanup(paths.home);
    cleanup(paths.projectDir);
  });

  test("identity chip shows local mode without cloud contact", async ({
    page,
  }) => {
    await page.goto(studio.url);
    await expect(page.getByText("local").first()).toBeVisible();
  });

  test("Run training completes through the local server and lights up the jobs UI", async ({
    page,
  }) => {
    await page.goto(studio.url);
    // The manifest tile resolves through /api/manifest (local build of the
    // linked SDK manifest).
    await expect(
      page.getByText("studio-local-e2e-trainer").first(),
    ).toBeVisible({ timeout: 30_000 });

    // Kick a run through the same API the Run Training button uses; the
    // /api/train child inherits the env hand-off and registers its job in
    // the dev server's local job store.
    const trainRes = await fetch(`${studio.url}/api/train`, {
      method: "POST",
      headers: {
        "x-arkor-studio-token": studio.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(trainRes.status).toBe(200);
    const streamText = await trainRes.text();
    expect(streamText).toContain("finished with status=completed");
    expect(streamText).toContain("exit=0");

    // The job is listed from the durable local store.
    const jobsRes = await fetch(`${studio.url}/api/jobs`, {
      headers: { "x-arkor-studio-token": studio.token },
    });
    const { jobs } = (await jobsRes.json()) as {
      jobs: { id: string; name: string; status: string }[];
    };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("studio-local-e2e-trainer");
    expect(jobs[0]?.status).toBe("completed");

    // The job detail page replays the SSE history from the local server:
    // status, loss chart data, and the completion event all render.
    await page.goto(`${studio.url}/#/jobs/${jobs[0]?.id ?? ""}`);
    await expect(page.getByText(/completed/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("training.completed").first()).toBeVisible();
  });
});
