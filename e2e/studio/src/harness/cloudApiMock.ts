import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type CloudApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export interface CloudApiMock {
  /** `http://127.0.0.1:<port>` — pass to `arkor dev` as `ARKOR_CLOUD_API_URL`. */
  baseUrl: string;
  /** Replace the catch-all handler. Useful for case-by-case overrides. */
  setHandler: (handler: CloudApiHandler) => void;
  /** Override a single route (`GET /v1/jobs`, `POST /v1/inference/chat`, …). */
  setRoute: (method: string, path: string, handler: CloudApiHandler) => void;
  /** Every request the server saw so far (latest last). */
  requests: ReadonlyArray<RecordedRequest>;
  close: () => Promise<void>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

interface RouteKey {
  method: string;
  path: string;
}

function keyOf(req: IncomingMessage): RouteKey {
  // Strip query before route matching so `/v1/jobs?orgSlug=…` hits the
  // `/v1/jobs` route table entry. Falls back to the request URL when
  // parsing fails (which it shouldn't for well-formed http requests).
  let path = req.url ?? "";
  const q = path.indexOf("?");
  if (q !== -1) path = path.slice(0, q);
  return { method: req.method ?? "GET", path };
}

const DEFAULT_ME_BODY = {
  user: { id: "user_e2e", email: null },
  orgs: [{ id: "org_e2e", slug: "studio-e2e-org", name: "Studio E2E" }],
};

const DEFAULT_JOBS_BODY = {
  jobs: [
    {
      id: "job-e2e-1",
      name: "studio-e2e-trainer",
      status: "running",
      createdAt: "2026-05-01T00:00:00.000Z",
      startedAt: "2026-05-01T00:00:01.000Z",
      completedAt: null,
      error: null,
      config: {},
    },
  ],
};

/**
 * Spin up an in-process http server that imitates the cloud-api routes
 * Studio's Hono server proxies through. Default handlers return canned
 * payloads matching the fixture's `orgSlug` / `projectSlug` so tests
 * that don't override anything still get a populated Overview, Jobs
 * list, and a Playground that streams a short response.
 *
 * Pattern lifted from `e2e/cli/src/arkor-whoami.test.ts` and extended
 * with the Studio routes (`/v1/jobs`, `/v1/jobs/:id/events/stream`,
 * `/v1/inference/chat`).
 */
export async function startFakeCloudApi(): Promise<CloudApiMock> {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, CloudApiHandler>();

  const defaultHandler: CloudApiHandler = (req, res) => {
    const key = keyOf(req);
    if (key.method === "GET" && key.path === "/v1/me") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(DEFAULT_ME_BODY));
      return;
    }
    if (key.method === "GET" && key.path === "/v1/jobs") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(DEFAULT_JOBS_BODY));
      return;
    }
    if (
      key.method === "GET" &&
      /^\/v1\/jobs\/[^/]+\/events\/stream$/.test(key.path)
    ) {
      // Minimum viable SSE: send one frame, leave the connection open
      // so the SPA's EventSource shows "connected" without firing
      // onerror. Tests that need richer streams override this route.
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.write(
        `event: status\ndata: ${JSON.stringify({ status: "running" })}\n\n`,
      );
      // Keep socket open: caller is responsible for cancelling.
      return;
    }
    if (key.method === "POST" && key.path === "/v1/inference/chat") {
      // OpenAI-style streaming envelope so `extractInferenceDelta`
      // pulls `choices[0].delta.content` cleanly.
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      const tokens = ["Hello", " from", " e2e"];
      for (const tok of tokens) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: tok } }],
          })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `no mock for ${key.method} ${key.path}` }));
  };

  let catchAll: CloudApiHandler = defaultHandler;

  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
    });
    const key = keyOf(req);
    const route = routes.get(`${key.method} ${key.path}`);
    // The `Map<string, CloudApiHandler>` type already guarantees `route`
    // is a function when present, but the lookup key derives from
    // request-controlled `req.method` / `req.url`. CodeQL flags any
    // dispatch through that path as "unvalidated dynamic method call"
    // — the explicit `typeof === "function"` guard is the documented
    // remediation and clarifies the contract for readers.
    if (typeof route === "function") {
      route(req, res);
      return;
    }
    catchAll(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Fake cloud-api could not bind a port");
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    setHandler: (h) => {
      catchAll = h;
    },
    setRoute: (method, path, h) => {
      routes.set(`${method.toUpperCase()} ${path}`, h);
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `closeAllConnections` is needed because we leave the SSE
        // socket from `/v1/jobs/:id/events/stream` open by design;
        // without it `server.close()` waits forever for the client to
        // hang up.
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
