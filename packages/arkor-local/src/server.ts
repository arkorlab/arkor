import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";

import { LOCAL_BACKENDS } from "./backends/registry";
import { currentPreflightEnv, selectBackend } from "./preflight";
import { RunManager } from "./runner";
import { isTerminalStatus, JobStore } from "./store";

import type { LocalTrainingBackend } from "./backends/types";
import type { StoredEvent } from "./store";
import type { JobConfig } from "arkor";
import type { Context } from "hono";
import type { AddressInfo } from "node:net";

/**
 * Chat proxying is provided by the inference manager; the server owns
 * request validation and adapter resolution, the manager owns child
 * lifecycle and streaming. Split as an interface so the training-only
 * pieces stay testable without any inference machinery.
 */
export interface ChatProxy {
  handleChat(args: {
    model: string;
    adapterPath: string | null;
    body: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<Response>;
  closeAll(): Promise<void>;
}

export interface LocalAppOptions {
  /** Bearer token every request must carry. At least 16 chars. */
  token: string;
  store: JobStore;
  runManager: RunManager;
  backend: LocalTrainingBackend;
  /** Directory holding the bundled Python shims. */
  shimDir: string;
  chatProxy?: ChatProxy;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const createJobSchema = z.object({
  name: z.string().min(1),
  // Loose on purpose, mirroring the cloud API: the backend's validateConfig
  // is the semantic gate; this only guards the envelope shape.
  config: z.looseObject({
    model: z.string().min(1),
    datasetSource: z.looseObject({ type: z.string() }),
  }),
});

const chatRequestSchema = z.looseObject({
  messages: z.array(z.looseObject({})).min(1),
  adapter: z
    .looseObject({
      jobId: z.string().min(1),
      step: z.number().int().nonnegative().optional(),
    })
    .optional(),
  baseModel: z.string().min(1).optional(),
});

/** Chat features the local backend cannot honour; rejected, never dropped. */
const UNSUPPORTED_CHAT_FEATURES = [
  "tools",
  "toolChoice",
  "responseFormat",
  "structuredOutputs",
] as const;

const SSE_PING_INTERVAL_MS = 15_000;

/**
 * The local training server: a loopback-only, bearer-token-guarded Hono app
 * implementing the subset of the Arkor Cloud API that the SDK and Studio
 * actually call. Scope query params (`orgSlug`, `projectSlug`) are accepted
 * and ignored everywhere; the local server has no orgs or projects.
 *
 * Deliberately NOT implemented: `/v1/auth/*` (local mode never mints
 * credentials), `/v1/projects*` (fixed scope), `/v1/endpoints*`
 * (deployments are cloud-only), embeddings.
 */
export function buildLocalApp(options: LocalAppOptions): Hono {
  const { token, store, runManager, backend, shimDir, chatProxy } = options;
  if (token.length < 16) {
    throw new Error(
      "buildLocalApp requires a token with at least 16 characters of entropy.",
    );
  }

  const app = new Hono();
  const loopbackHostPattern = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

  // Same DNS-rebinding boundary as the Studio server: a page rebound onto
  // 127.0.0.1 still carries its original Host header.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!loopbackHostPattern.test(host)) {
      return c.json({ error: "local training server is loopback-only" }, 403);
    }
    await next();
  });

  // Bearer token on every route. The host guard alone is not enough: a
  // cross-origin "simple" POST from another local browser tab reaches
  // 127.0.0.1 with a passing Host header, and POST /v1/jobs spawns
  // processes. Same threat model as Studio's CSRF token.
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokensMatch(provided, token)) {
      return c.json({ error: "missing or invalid local server token" }, 401);
    }
    await next();
  });

  app.post("/v1/jobs", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: `invalid job request: ${parsed.error.message}` },
        400,
      );
    }
    // The loose zod envelope guarantees `model` and `datasetSource.type`
    // only; JobConfig's discriminated dataset union is validated for real
    // inside `backend.validateConfig` right below.
    const config = parsed.data.config as unknown as JobConfig;
    const validation = backend.validateConfig(config);
    if (!validation.ok) {
      return c.json(
        {
          error:
            "the local training backend cannot run this config:\n" +
            validation.errors.map((e) => `  - ${e}`).join("\n"),
        },
        400,
      );
    }
    const record = await store.createJob({
      name: parsed.data.name,
      config,
      backendId: backend.id,
    });
    // Fire and forget: every failure path inside startRun ends in a
    // training.failed event on the job, mirroring how the cloud reports
    // post-submit failures through the stream rather than the POST.
    void runManager.startRun({
      jobId: record.job.id,
      config,
      backend,
      paths: store.paths(record.job.id, shimDir),
    });
    return c.json({ job: record.job }, 201);
  });

  app.get("/v1/jobs", async (c) => {
    return c.json({ jobs: await store.listJobs() });
  });

  app.get("/v1/jobs/:id", async (c) => {
    const record = await store.getJob(c.req.param("id"));
    if (!record) return c.json({ error: "job not found" }, 404);
    return c.json({ job: record.job });
  });

  app.post("/v1/jobs/:id/cancel", async (c) => {
    const jobId = c.req.param("id");
    const record = await store.getJob(jobId);
    if (!record) return c.json({ error: "job not found" }, 404);
    if (isTerminalStatus(record.job.status)) {
      // Idempotent: cancelling a finished job is a no-op, same as cloud.
      return c.json({ job: record.job });
    }
    const hadChild = await runManager.cancel(jobId);
    if (!hadChild) {
      // Queued but never spawned (or the child is already gone): terminate
      // the record directly so the stream still ends. Re-read first: the
      // child's exit synthesis can have terminalised the record between
      // the status check above and cancel() returning false, and a second
      // terminal event would break the one-terminal-per-job contract.
      const current = await store.getJob(jobId);
      if (current && !isTerminalStatus(current.job.status)) {
        const timestamp = new Date().toISOString();
        await store.appendEvent(jobId, {
          type: "training.failed",
          jobId,
          timestamp,
          error: "Job cancelled",
        });
        await store.updateJob(jobId, (r) => {
          r.job.status = "cancelled";
          r.job.error = "Job cancelled";
          r.job.completedAt = timestamp;
          r.pid = null;
        });
        store.notifyEnded(jobId);
      } else {
        // The job ended on its own; the parked pre-spawn cancellation can
        // never be consumed (this jobId will not start again).
        runManager.forgetPreSpawnCancel(jobId);
      }
    }
    const updated = await store.getJob(jobId);
    return c.json({ job: updated?.job ?? record.job });
  });

  app.get("/v1/jobs/:id/events/stream", async (c) => {
    const jobId = c.req.param("id");
    const record = await store.getJob(jobId);
    if (!record) return c.json({ error: "job not found" }, 404);
    const lastEventIdHeader = c.req.header("last-event-id");
    const afterSeq = lastEventIdHeader ? Number(lastEventIdHeader) : 0;
    return sseResponse(store, jobId, Number.isFinite(afterSeq) ? afterSeq : 0);
  });

  app.post("/v1/inference/chat", async (c) => {
    if (!chatProxy) {
      return c.json(
        { error: "local inference is not available in this server" },
        503,
      );
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: `invalid chat request: ${parsed.error.message}` },
        400,
      );
    }
    for (const feature of UNSUPPORTED_CHAT_FEATURES) {
      const value = (parsed.data as Record<string, unknown>)[feature];
      if (value !== undefined && value !== null) {
        return c.json(
          { error: `${feature} is not supported in local mode` },
          400,
        );
      }
    }
    const target = await resolveChatTarget(store, parsed.data, backend, c);
    if (target instanceof Response) return target;
    return chatProxy.handleChat({
      model: target.model,
      adapterPath: target.adapterPath,
      body: parsed.data as Record<string, unknown>,
      signal: c.req.raw.signal,
    });
  });

  app.get("/v1/me", (c) => {
    return c.json({
      user: { id: "local", email: null },
      orgs: [{ id: "local", slug: "local", name: "Local" }],
    });
  });

  return app;
}

type ChatTarget = { model: string; adapterPath: string | null };

/**
 * Resolve which model (and optional adapter directory) a chat request
 * targets: `adapter.jobId` points at a finished or running local job's
 * normalised adapter output; `baseModel` chats with a bare model.
 */
async function resolveChatTarget(
  store: JobStore,
  body: z.infer<typeof chatRequestSchema>,
  backend: LocalTrainingBackend,
  c: Context,
): Promise<ChatTarget | Response> {
  if (backend.inference === undefined) {
    return c.json(
      {
        error: `the ${backend.id} backend does not support local inference`,
      },
      501,
    );
  }
  if (body.adapter) {
    const record = await store.getJob(body.adapter.jobId);
    if (!record) {
      return c.json({ error: `unknown local job: ${body.adapter.jobId}` }, 404);
    }
    const adapterPath = await resolveAdapterDir(
      store,
      body.adapter.jobId,
      body.adapter.step,
    );
    if (!adapterPath) {
      return c.json(
        {
          error:
            "no adapter found for this job yet (training may still be " +
            "before its first checkpoint)",
        },
        404,
      );
    }
    return { model: record.job.config.model, adapterPath };
  }
  if (body.baseModel) {
    return { model: body.baseModel, adapterPath: null };
  }
  return c.json(
    { error: "chat request must carry `adapter` or `baseModel`" },
    400,
  );
}

async function resolveAdapterDir(
  store: JobStore,
  jobId: string,
  step: number | undefined,
): Promise<string | null> {
  const adaptersDir = join(store.jobDir(jobId), "adapters");
  const candidates =
    step === undefined
      ? [join(adaptersDir, "final")]
      : [join(adaptersDir, `step-${String(step)}`), join(adaptersDir, "final")];
  // `final` doubles as the fallback for step-addressed requests: at
  // onCheckpoint time the latest weights ARE that checkpoint, and mlx-lm
  // updates the final adapter in place as it saves.
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "adapter_config.json"));
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function sseResponse(
  store: JobStore,
  jobId: string,
  afterSeq: number,
): Response {
  const enc = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let done = false;
      let lastSentSeq = afterSeq;
      const safeWrite = (text: string) => {
        if (done) return;
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          done = true;
        }
      };
      const writeEvent = (stored: StoredEvent) => {
        if (stored.seq <= lastSentSeq) return;
        lastSentSeq = stored.seq;
        safeWrite(
          `id: ${String(stored.seq)}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored.event)}\n\n`,
        );
      };
      const finish = () => {
        if (done) return;
        safeWrite(`event: end\ndata: {}\n\n`);
        done = true;
        cleanup?.();
        try {
          controller.close();
        } catch {
          // client went away first
        }
      };

      const ping = setInterval(() => {
        safeWrite(`event: ping\ndata: {}\n\n`);
      }, SSE_PING_INTERVAL_MS);
      ping.unref();

      // Subscribe BEFORE replaying so nothing appended between the replay
      // read and the subscription is lost, but BUFFER live events until the
      // replay has been written: writing a live event (say seq 5) ahead of
      // replayed history (3, 4) would advance `lastSentSeq` past the
      // replayed rows and the dedupe guard would silently drop them. The
      // buffer preserves ordering; the guard then removes the overlap.
      // Object properties (not `let` bindings) because the subscriber
      // closures mutate them across the awaits below.
      const phase = { replaying: true, endDeferred: false };
      const buffered: StoredEvent[] = [];
      const unsubscribe = store.subscribe(jobId, {
        onEvent: (stored) => {
          if (phase.replaying) buffered.push(stored);
          else writeEvent(stored);
        },
        onEnd: () => {
          // Deferred so the terminal event (buffered or replayed) is
          // written before the `end` marker.
          if (phase.replaying) phase.endDeferred = true;
          else finish();
        },
      });
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };

      for (const stored of await store.replayAfter(jobId, afterSeq)) {
        writeEvent(stored);
      }
      phase.replaying = false;
      for (const stored of buffered) writeEvent(stored);
      buffered.length = 0;
      if (phase.endDeferred) {
        finish();
        return;
      }
      // A job that ended before this connection replays its history and
      // closes immediately; there will be no live `end` notification.
      const record = await store.getJob(jobId);
      if (record && isTerminalStatus(record.job.status)) finish();
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    },
  });
}

export interface LocalServer {
  url: string;
  token: string;
  backend: LocalTrainingBackend;
  close(): Promise<void>;
}

export interface StartLocalServerOptions {
  /** Project root; `.arkor/local/` lives beneath it. */
  cwd: string;
  /** Directory holding the bundled Python shims. */
  shimDir: string;
  /** Backend id override (`--backend <id>`); auto-detects when absent. */
  backendId?: string;
  /** Injection seams for tests. */
  backends?: readonly LocalTrainingBackend[];
  token?: string;
  chatProxyFactory?: (args: {
    backend: LocalTrainingBackend;
    shimDir: string;
  }) => ChatProxy;
}

/**
 * Boot the local training server on an ephemeral loopback port: preflight
 * and select a backend, reconcile orphaned jobs from previous runs, bind,
 * and return the env hand-off values plus a close function that tears down
 * every child.
 */
export async function startLocalServer(
  options: StartLocalServerOptions,
): Promise<LocalServer> {
  const backends = options.backends ?? LOCAL_BACKENDS;
  const backend = await selectBackend({
    backends,
    env: currentPreflightEnv(),
    requestedId: options.backendId,
  });
  const token = options.token ?? randomBytes(32).toString("base64url");
  const rootDir = join(options.cwd, ".arkor", "local");
  // Created eagerly so satellite files (inference.log) can be opened before
  // the first job ever writes beneath it.
  await mkdir(rootDir, { recursive: true });
  const store = new JobStore({ rootDir });
  await store.reconcileOrphans();
  const runManager = new RunManager({ store });
  const chatProxy = options.chatProxyFactory?.({
    backend,
    shimDir: options.shimDir,
  });
  const app = buildLocalApp({
    token,
    store,
    runManager,
    backend,
    shimDir: options.shimDir,
    chatProxy,
  });

  const { server, url } = await new Promise<{
    server: ReturnType<typeof serve>;
    url: string;
  }>((resolve, reject) => {
    const s = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        // Port 0 delegates allocation to the kernel: two concurrent
        // `arkor dev --local` instances can never collide.
        port: 0,
      },
      (info: AddressInfo) => {
        resolve({ server: s, url: `http://127.0.0.1:${String(info.port)}` });
      },
    );
    s.once("error", reject);
  });

  return {
    url,
    token,
    backend,
    close: async () => {
      await runManager.closeAll();
      await chatProxy?.closeAll();
      store.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
