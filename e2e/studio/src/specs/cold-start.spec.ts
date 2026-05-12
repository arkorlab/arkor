import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "../harness/fixture";

const QUEUED_JOB = {
  id: "job-cold-start",
  name: "cold-start-trainer",
  // The job stays `queued` on the wire until our deferred SSE fires
  // `training.started`. The display-status derivation in the SPA
  // promotes that to `Warming up GPU` while the EventSource is open
  // without a `training.started` frame.
  status: "queued",
  createdAt: new Date(Date.now() - 5_000).toISOString(),
  startedAt: null,
  completedAt: null,
  error: null,
  config: { model: "unsloth/gemma-4-E4B-it" },
};

function jobsBody(status: "queued" | "running" | "completed" = "queued") {
  const job = { ...QUEUED_JOB, status };
  if (status === "running") {
    return { jobs: [{ ...job, startedAt: new Date().toISOString() }] };
  }
  if (status === "completed") {
    const completedAt = new Date().toISOString();
    return {
      jobs: [
        {
          ...job,
          status,
          startedAt: completedAt,
          completedAt,
        },
      ],
    };
  }
  return { jobs: [job] };
}

interface DeferredSseControls {
  /** Send `training.started` over the still-open SSE socket. */
  emitStarted: () => Promise<void>;
  /** Send `training.completed` and end the stream. */
  emitCompleted: () => Promise<void>;
  /** Resolves once the SSE socket has connected. */
  connected: Promise<void>;
}

/**
 * Install a `/v1/jobs/{id}/events/stream` route that opens the SSE
 * socket and keeps it open with no frames until the caller invokes
 * `emitStarted()` / `emitCompleted()`. Mirrors the "cold start, then
 * training begins" wire trace.
 */
function installDeferredSseRoute(cloudApi: {
  setRoute: (
    method: string,
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ) => void;
}): DeferredSseControls {
  let resolveConnected: () => void;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });

  // Held outside the handler so test bodies can drive frames from the
  // outside. The handler captures the latest response and resolves the
  // `connected` gate when the socket actually attaches.
  let active: ServerResponse | null = null;

  cloudApi.setRoute(
    "GET",
    `/v1/jobs/${QUEUED_JOB.id}/events/stream`,
    (req, res) => {
      const url = new URL(req.url ?? "", "http://x");
      if (
        url.searchParams.get("orgSlug") !== "studio-e2e-org" ||
        url.searchParams.get("projectSlug") !== "studio-e2e-project"
      ) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "scope mismatch" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      // Empty comment frame keeps the SSE socket alive for browsers
      // that wait for a first chunk before reporting "open" but
      // crucially does not carry a named event, so the SPA stays in
      // `provisioning` (it is waiting for `training.started`).
      res.write(":\n\n");
      active = res;
      resolveConnected();
    },
  );

  return {
    connected,
    emitStarted: async () => {
      await connected;
      if (!active) throw new Error("SSE socket was not opened");
      active.write(
        `event: training.started\ndata: ${JSON.stringify({
          timestamp: new Date().toISOString(),
        })}\n\n`,
      );
    },
    emitCompleted: async () => {
      await connected;
      if (!active) throw new Error("SSE socket was not opened");
      active.write(
        `event: training.completed\ndata: ${JSON.stringify({
          timestamp: new Date().toISOString(),
          artifacts: [{ id: "artifact-1" }],
        })}\n\n`,
      );
      active.end();
    },
  };
}

test.describe("Cold-start training UX", () => {
  test("shows the Warming up GPU phase before training.started arrives", async ({
    page,
    studio,
    cloudApi,
  }) => {
    cloudApi.setRoute("GET", "/v1/jobs", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jobsBody("queued")));
    });
    const sse = installDeferredSseRoute(cloudApi);

    await page.goto(`${studio.url}/#/jobs/${QUEUED_JOB.id}`);
    await sse.connected;

    await expect(
      page.getByText("Warming up the GPU for this job."),
    ).toBeVisible();
    await expect(page.getByText("Waiting for GPU").first()).toBeVisible();

    // Flip the wire state to running and emit the SSE frame: the
    // display should switch to Running with the loss-chart placeholder
    // gone.
    cloudApi.setRoute("GET", "/v1/jobs", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jobsBody("running")));
    });
    await sse.emitStarted();

    await expect(
      page.getByText("Warming up the GPU for this job."),
    ).toBeHidden();
  });

  test("fires a desktop toast on training.completed with notification permission granted", async ({
    page,
    studio,
    cloudApi,
    context,
  }) => {
    await context.grantPermissions(["notifications"]);
    cloudApi.setRoute("GET", "/v1/jobs", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jobsBody("queued")));
    });
    const sse = installDeferredSseRoute(cloudApi);

    await page.goto(`${studio.url}/#/jobs/${QUEUED_JOB.id}`);
    await sse.connected;
    await sse.emitStarted();

    cloudApi.setRoute("GET", "/v1/jobs", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jobsBody("completed")));
    });
    await sse.emitCompleted();

    // Toast carries the run name and the completed label.
    await expect(
      page.getByText("Training run completed").first(),
    ).toBeVisible();
    await expect(
      page.getByText(/cold-start-trainer \(1 artifact\)/).first(),
    ).toBeVisible();
  });

  test("falls back to in-page toast only when notification permission is denied", async ({
    page,
    studio,
    cloudApi,
    context,
  }) => {
    await context.clearPermissions();
    cloudApi.setRoute("GET", "/v1/jobs", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jobsBody("queued")));
    });
    const sse = installDeferredSseRoute(cloudApi);

    await page.goto(`${studio.url}/#/jobs/${QUEUED_JOB.id}`);
    await sse.connected;
    await sse.emitStarted();

    cloudApi.setRoute("GET", "/v1/jobs", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(jobsBody("completed")));
    });
    await sse.emitCompleted();

    await expect(
      page.getByText("Training run completed").first(),
    ).toBeVisible();
  });
});
