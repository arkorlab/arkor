import { expect, test } from "../harness/fixture";

test.describe("Studio pages", () => {
  test("Overview renders and pulls jobs from /api/jobs", async ({
    page,
    studio,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(studio.url);
    await expect(
      page.getByRole("heading", { name: "Overview" }),
    ).toBeVisible();
    // The default fake cloud-api returns one job named "studio-e2e-trainer".
    await expect(page.getByText("studio-e2e-trainer").first()).toBeVisible();
    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("Jobs list renders rows from /api/jobs", async ({ page, studio }) => {
    await page.goto(`${studio.url}/#/jobs`);
    await expect(
      page.getByRole("heading", { name: /Jobs/ }),
    ).toBeVisible();
    await expect(page.getByText("studio-e2e-trainer").first()).toBeVisible();
  });

  test("Job detail attaches to the SSE event stream", async ({
    page,
    studio,
    cloudApi,
  }) => {
    // Override the SSE route so we can deterministically assert on
    // payloads the SPA renders. Default handler also streams a single
    // status frame, but pinning it here makes the test independent of
    // the default's exact wording.
    cloudApi.setRoute(
      "GET",
      "/v1/jobs/job-e2e-1/events/stream",
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.write(
          `event: training.started\ndata: ${JSON.stringify({
            startedAt: "2026-05-01T00:00:01.000Z",
          })}\n\n`,
        );
        res.write(
          `event: log\ndata: ${JSON.stringify({
            line: "studio-e2e-log-line",
          })}\n\n`,
        );
      },
    );

    await page.goto(`${studio.url}/#/jobs/job-e2e-1`);
    // The detail page should mount and start the SSE — the request
    // mock above will record at least one /v1/jobs/.../events/stream
    // hit if the SPA's openJobEvents() ran.
    await expect.poll(() =>
      cloudApi.requests.some((r) =>
        /^\/v1\/jobs\/job-e2e-1\/events\/stream/.test(r.url),
      ),
    ).toBe(true);
  });
});
