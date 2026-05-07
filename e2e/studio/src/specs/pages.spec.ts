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
    // What this test actually checks: that JobDetail mounts an
    // `EventSource` against `/api/jobs/:id/events` and that the
    // Studio server proxies it to cloud-api with the correct scope
    // query params — i.e. the SSE attach + URL-construction contract.
    // It does NOT exercise the page's reaction to specific event
    // payloads (UI rendering of `training.log` step/loss is covered
    // by the studio-app unit tests). The override exists to (a) make
    // the assertion deterministic by replacing the default handler
    // (which keeps the socket open with a different framing), and
    // (b) re-enforce the scope check that `setRoute` would otherwise
    // bypass — `setRoute` matches on path-only, so without this a
    // regression that drops `orgSlug`/`projectSlug` could still
    // succeed against the registered route handler.
    cloudApi.setRoute(
      "GET",
      "/v1/jobs/job-e2e-1/events/stream",
      (req, res) => {
        const url = new URL(req.url ?? "", "http://x");
        if (
          url.searchParams.get("orgSlug") !== "studio-e2e-org" ||
          url.searchParams.get("projectSlug") !== "studio-e2e-project"
        ) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "scope mismatch on events stream override",
              received: {
                orgSlug: url.searchParams.get("orgSlug"),
                projectSlug: url.searchParams.get("projectSlug"),
              },
            }),
          );
          return;
        }
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
    // The detail page should mount and start the SSE. Assert against
    // the recorded URL with both required scope params present so a
    // proxy regression that drops them is caught here even though
    // the override above already 400s on mismatch (defence in depth
    // against the override being relaxed in the future).
    await expect
      .poll(() =>
        cloudApi.requests.some(
          (r) =>
            /^\/v1\/jobs\/job-e2e-1\/events\/stream\?/.test(r.url) &&
            r.url.includes("orgSlug=studio-e2e-org") &&
            r.url.includes("projectSlug=studio-e2e-project"),
        ),
      )
      .toBe(true);
  });
});
