import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createClient } from "@arkor/cloud-api-client";
import { CloudApiClient, CloudApiError } from "../core/client";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
  writeCredentials,
  requestAnonymousToken,
  type Credentials,
} from "../core/credentials";
import { recordDeprecation, tapDeprecation } from "../core/deprecation";
import { SDK_VERSION } from "../core/version";
import { ensureProjectState } from "../core/projectState";
import { readState } from "../core/state";
import { readManifestSummary, summariseBuiltManifest } from "./manifest";
import type { HmrCoordinator, HmrEvent } from "./hmr";
import { TrainRegistry, type RestartTarget } from "./trainRegistry";

const DEPRECATION_HEADERS = ["Deprecation", "Sunset", "Warning"] as const;
function copyDeprecationHeaders(from: Headers, to: Headers): void {
  for (const name of DEPRECATION_HEADERS) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
}
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface StudioServerOptions {
  baseUrl?: string;
  /** Absolute path to the bundled Studio assets (index.html). */
  assetsDir?: string;
  /**
   * When true, auto-bootstrap anonymous credentials on first hit if none are
   * present. Mirrors the CLI default.
   */
  autoAnonymous?: boolean;
  /**
   * Per-launch CSRF token. Every `/api/*` request must include it via header
   * `X-Arkor-Studio-Token`; the job-event stream also accepts `?studioToken=`
   * because `EventSource` cannot carry custom headers. The token is injected
   * into the served `index.html` as a `<meta>` tag so the same-origin SPA can
   * read it; cross-origin tabs cannot, so even a "simple" CORS POST without
   * preflight is rejected.
   */
  studioToken: string;
  /**
   * Working directory used to resolve / validate `body.file` for `/api/train`.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * Absolute path to the `arkor` bin spawned by `/api/train`. Defaults to
   * `dist/bin.mjs` resolved as a sibling of the bundled studio code (this
   * file is inlined into `dist/bin.mjs` at build time, so `./bin.mjs` from
   * here points at the bin itself). Override in tests.
   */
  binPath?: string;
  /**
   * Optional HMR coordinator. When provided, the server registers
   * `/api/dev/events` as an SSE stream that pushes rebuild / error events to
   * the SPA, and rebuilds also signal SIGTERM to active `/api/train`
   * subprocesses so they early-stop at the next checkpoint and the SPA can
   * restart them with the new bundle. Wired in by `arkor dev`; left
   * undefined for any non-dev consumer of `buildStudioApp`.
   */
  hmr?: HmrCoordinator;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function htmlAttrEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );
}

function injectStudioToken(html: string, token: string): string {
  const meta = `<meta name="arkor-studio-token" content="${htmlAttrEscape(token)}">`;
  const idx = html.indexOf("</head>");
  if (idx === -1) return `${meta}${html}`;
  return `${html.slice(0, idx)}${meta}${html.slice(idx)}`;
}

export function buildStudioApp(options: StudioServerOptions) {
  const baseUrl = options.baseUrl ?? defaultArkorCloudApiUrl();
  const assetsDir = options.assetsDir ?? join(__dirname, "assets");
  const autoAnonymous = options.autoAnonymous ?? true;
  const studioToken = options.studioToken;
  const trainCwd = options.cwd ?? process.cwd();
  // `studio/server.ts` is bundled into `dist/bin.mjs` (it isn't reachable
  // from `src/index.ts`, so tsdown doesn't extract it as a shared chunk).
  // The bin therefore sits *next* to this code at runtime, not one
  // directory up — `../bin.mjs` would resolve to the package root.
  const trainBinPath =
    options.binPath ?? fileURLToPath(new URL("./bin.mjs", import.meta.url));

  if (!studioToken || studioToken.length < 16) {
    throw new Error(
      "buildStudioApp requires a studioToken with at least 16 characters of entropy.",
    );
  }

  const app = new Hono();

  const loopbackHostPattern = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
  // Routes where `?studioToken=` is accepted instead of the
  // `X-Arkor-Studio-Token` header. Used only for `EventSource` streams,
  // which cannot send custom headers. Adding to this list is CSRF-sensitive:
  // it must always be a GET stream-only route, never a mutation endpoint.
  const eventStreamPathPattern =
    /^\/api\/jobs\/[^/]+\/events$|^\/api\/dev\/events$/;

  // Host-header guard for every route, including static HTML that carries the
  // per-launch Studio token. This is the DNS-rebinding boundary: a victim
  // navigated to `evil.com` rebound onto 127.0.0.1 still sends `Host: evil.com`.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!loopbackHostPattern.test(host)) {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "Studio API is loopback-only" }, 403);
      }
      return c.text("Studio is loopback-only", 403);
    }
    await next();
  });

  // CSRF defense for `/api/*`:
  //   1. Per-launch token. CORS is intentionally not configured: the SPA
  //      is same-origin so CORS adds no value, and reflecting `*` would let
  //      "simple" cross-origin POSTs (text/plain, urlencoded) skip preflight
  //      and reach the handler. The token check rejects those — an attacker
  //      page can't read the SPA's <meta> from another origin.
  //   2. `?studioToken=` is accepted only on the job-event stream route
  //      because `EventSource` cannot send custom headers. Mutation routes
  //      require the header so a leaked token in a URL is not enough to POST.
  app.use("/api/*", async (c, next) => {
    const queryTokenAllowed =
      c.req.method === "GET" && eventStreamPathPattern.test(c.req.path);
    const provided =
      c.req.header("x-arkor-studio-token") ??
      (queryTokenAllowed ? c.req.query("studioToken") : undefined) ??
      "";
    if (!tokensMatch(provided, studioToken)) {
      return c.json({ error: "Missing or invalid studio token" }, 403);
    }
    await next();
  });

  async function getCredentials(): Promise<Credentials> {
    const existing = await readCredentials();
    if (existing) return existing;
    if (!autoAnonymous) {
      throw new Error("No credentials on file. Run `arkor login` first.");
    }
    const anon = await requestAnonymousToken(baseUrl, "cli");
    const creds: Credentials = {
      mode: "anon",
      token: anon.token,
      anonymousId: anon.anonymousId,
      arkorCloudApiUrl: baseUrl,
      orgSlug: anon.orgSlug,
    };
    await writeCredentials(creds);
    return creds;
  }

  async function getToken(): Promise<string> {
    const c = await getCredentials();
    return c.mode === "anon" ? c.token : c.accessToken;
  }

  function createRpc() {
    return createClient({
      baseUrl,
      token: getToken,
      clientVersion: SDK_VERSION,
      // The wrapper around `recordDeprecation` is a workaround for a
      // bug in `@arkor/cloud-api-client` where a `void` return is fed
      // into `typeof result.then === 'function'`, which throws and
      // logs `[@arkor/cloud-api-client] onDeprecation handler threw;
      // ignoring:` on every deprecated response. Returning `null`
      // short-circuits that check (`null !== null` is false) without
      // changing the recorded-deprecation behavior.
      onDeprecation: (notice) => {
        recordDeprecation(notice);
        return null;
      },
    });
  }

  // ---- API routes ---------------------------------------------------------

  app.get("/api/credentials", async (c) => {
    const token = await getToken();
    const creds = await getCredentials();
    const state = await readState(trainCwd);
    return c.json({
      token,
      mode: creds.mode,
      baseUrl,
      orgSlug: state?.orgSlug ?? (creds.mode === "anon" ? creds.orgSlug : null),
      projectSlug: state?.projectSlug ?? null,
    });
  });

  app.get("/api/me", async (c) => {
    const rpc = createRpc();
    const res = await rpc.v1.me.$get();
    const body = await res.text();
    const headers = new Headers({ "content-type": "application/json" });
    copyDeprecationHeaders(res.headers, headers);
    return new Response(body, { status: res.status, headers });
  });

  app.get("/api/manifest", async (c) => {
    try {
      const manifest = await readManifestSummary(trainCwd);
      return c.json(manifest);
    } catch (err) {
      // The user's `src/arkor/index.ts` may not exist yet (fresh scaffold) or
      // the bundle may throw at import time. Surface the error as 400 so the
      // SPA can render a hint instead of treating it as an infrastructure
      // failure.
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/api/jobs", async (c) => {
    const state = await readState(trainCwd);
    if (!state) return c.json({ jobs: [] });
    const rpc = createRpc();
    const res = await rpc.v1.jobs.$get({
      query: { orgSlug: state.orgSlug, projectSlug: state.projectSlug },
    });
    const body = await res.text();
    const headers = new Headers({ "content-type": "application/json" });
    copyDeprecationHeaders(res.headers, headers);
    return new Response(body, {
      status: res.status,
      headers,
    });
  });

  app.get("/api/jobs/:id/events", async (c) => {
    const id = c.req.param("id");
    const state = await readState(trainCwd);
    if (!state) return c.json({ error: "No project state" }, 400);
    const token = await getToken();
    const url = `${baseUrl}/v1/jobs/${encodeURIComponent(id)}/events/stream?orgSlug=${encodeURIComponent(state.orgSlug)}&projectSlug=${encodeURIComponent(state.projectSlug)}`;
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Arkor-Client": `arkor/${SDK_VERSION}`,
        Accept: "text/event-stream",
        ...(c.req.header("Last-Event-ID")
          ? { "Last-Event-ID": c.req.header("Last-Event-ID") as string }
          : {}),
      },
    });
    // This route bypasses `createRpc()` (the SSE body has to be streamed
    // straight through), so deprecation propagation has to be wired by
    // hand: record the notice into the SDK's latest-wins store and
    // forward the Deprecation/Warning/Sunset headers to the browser
    // alongside the event stream.
    tapDeprecation(upstream, SDK_VERSION);
    const headers = new Headers();
    headers.set(
      "content-type",
      upstream.headers.get("content-type") ?? "text/event-stream",
    );
    headers.set("cache-control", "no-cache, no-transform");
    copyDeprecationHeaders(upstream.headers, headers);
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  // Active `/api/train` subprocesses. The registry encapsulates the
  // signal-dispatch policy — see `studio/trainRegistry.ts`.
  const activeTrains = new TrainRegistry();

  app.post("/api/train", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { file?: string };
    let trainFile: string | undefined;
    if (body.file) {
      // Resolve symlinks before the containment check — `path.resolve` is purely
      // lexical, so a symlink under the project directory pointing at e.g.
      // `/etc/passwd` would otherwise pass `startsWith(baseAbs + sep)`. The
      // bin spawned below would then dlopen the link's target.
      let baseAbs: string;
      let abs: string;
      try {
        baseAbs = await realpath(resolve(trainCwd));
        abs = await realpath(resolve(baseAbs, body.file));
      } catch {
        return c.json(
          { error: "file does not exist or is not accessible" },
          400,
        );
      }
      if (abs !== baseAbs && !abs.startsWith(baseAbs + sep)) {
        return c.json(
          { error: "file must be inside the project directory" },
          400,
        );
      }
      trainFile = abs;
    }
    // Read the current manifest before spawn so the configHash is on
    // hand for HMR's "hot-swap vs restart" decision later. Building the
    // manifest also pre-warms `.arkor/build/index.mjs` for the
    // subprocess's `runStart`. A failure here is non-fatal — the spawn
    // proceeds with `configHash: null`, which forces SIGTERM (full
    // restart) on the next rebuild.
    let configHash: string | null = null;
    try {
      const manifest = await readManifestSummary(trainCwd);
      configHash = manifest.configHash;
    } catch {
      // ignore — `arkor start` will surface its own build error to the
      // SPA via stderr; we only needed configHash for HMR routing.
    }
    const args = [trainBinPath, "start"];
    if (trainFile) args.push(trainFile);
    const child = spawn(process.execPath, args, {
      stdio: "pipe",
      cwd: trainCwd,
    });
    activeTrains.register(child, { trainFile, configHash });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        child.stdout.on("data", (d) => controller.enqueue(enc.encode(d)));
        child.stderr.on("data", (d) => controller.enqueue(enc.encode(d)));
        child.on("close", (code) => {
          activeTrains.unregister(child.pid);
          controller.enqueue(enc.encode(`\n---\nexit=${code}\n`));
          controller.close();
        });
      },
      cancel() {
        activeTrains.unregister(child.pid);
        child.kill();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

  // `/api/dev/events` — SSE stream of HMR rebuild / error notifications.
  // Only active when `arkor dev` passed an HMR coordinator. The CSRF model
  // accepts `?studioToken=` here (whitelisted in `eventStreamPathPattern`)
  // because `EventSource` cannot send headers. When HMR is not configured
  // the route still has an explicit 404 so the request doesn't fall through
  // to the SPA index.html (which would mislead the SPA into thinking the
  // EventSource connected successfully).
  if (!options.hmr) {
    app.get("/api/dev/events", (c) =>
      c.json({ error: "HMR not enabled" }, 404),
    );
  }
  if (options.hmr) {
    const hmr = options.hmr;
    app.get("/api/dev/events", (c) => {
      let unsubscribe: (() => void) | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (
            event: HmrEvent & {
              restart?: boolean;
              hotSwap?: boolean;
              restartTargets?: RestartTarget[];
              hotSwapTargets?: RestartTarget[];
            },
          ) => {
            const payload = JSON.stringify(event);
            try {
              controller.enqueue(
                enc.encode(`event: ${event.type}\ndata: ${payload}\n\n`),
              );
            } catch {
              // controller closed mid-write; the unsubscribe path below
              // takes care of the rest.
            }
          };
          unsubscribe = hmr.subscribe((event) => {
            if (event.type !== "rebuild" || activeTrains.size === 0) {
              send(event);
              return;
            }
            // Per-child decision: if the rebuilt bundle's `configHash`
            // matches the child's spawn-time hash, the cloud-side run
            // is unaffected — SIGUSR2 lets the runner re-import and
            // call `Trainer.replaceCallbacks`. Otherwise SIGTERM
            // triggers `Trainer.requestEarlyStop` so the next
            // checkpoint lands before the SPA re-spawns.
            const nextHash = event.configHash ?? null;
            const hotSwapTargets = activeTrains.notifyCallbackReload(nextHash);
            const restartTargets =
              activeTrains.requestEarlyStopOnMismatch(nextHash);
            send({
              ...event,
              hotSwap: hotSwapTargets.length > 0,
              hotSwapTargets,
              restart: restartTargets.length > 0,
              restartTargets,
            });
          });
        },
        cancel() {
          unsubscribe?.();
          unsubscribe = null;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
        },
      });
    });
  }

  // Playground hits this so mid-training inference from Studio has the same
  // auth path as the rest of /api/*. State is auto-bootstrapped (anon only)
  // so the Playground's base-model mode works on a fresh launch with no
  // prior `arkor init`.
  app.post("/api/inference/chat", async (c) => {
    let credentials: Credentials;
    let state: { orgSlug: string; projectSlug: string };
    try {
      credentials = await getCredentials();
      const client = new CloudApiClient({ baseUrl, credentials });
      state = await ensureProjectState({ cwd: trainCwd, client, credentials });
    } catch (err) {
      // Propagate cloud-api's status verbatim (e.g. 401 / 403 / 5xx) so the
      // SPA / clients can react appropriately — collapsing everything to 400
      // would mis-report upstream outages and auth failures. Anything else
      // (local writeState failures, missing-credentials guard) is treated as
      // a server-side error.
      if (err instanceof CloudApiError) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: err.status,
          headers: { "content-type": "application/json" },
        });
      }
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
    const token =
      credentials.mode === "anon" ? credentials.token : credentials.accessToken;
    const body = await c.req.text();
    const url = `${baseUrl}/v1/inference/chat?orgSlug=${encodeURIComponent(state.orgSlug)}&projectSlug=${encodeURIComponent(state.projectSlug)}`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Arkor-Client": `arkor/${SDK_VERSION}`,
      },
      body,
    });
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    headers.set("cache-control", "no-cache, no-transform");
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  // ---- Static assets (SPA-style fallback) ---------------------------------

  const CONTENT_TYPES: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    ico: "image/x-icon",
    map: "application/json",
  };

  async function readAsset(relPath: string): Promise<Response | null> {
    const cleaned = relPath.replace(/^\/+/, "");
    try {
      const file = await readFile(join(assetsDir, cleaned));
      const ext = cleaned.slice(cleaned.lastIndexOf(".") + 1);
      if (ext === "html") {
        const html = injectStudioToken(file.toString("utf8"), studioToken);
        return new Response(html, {
          status: 200,
          headers: { "content-type": CONTENT_TYPES.html! },
        });
      }
      return new Response(file, {
        status: 200,
        headers: {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        },
      });
    } catch {
      return null;
    }
  }

  app.get("*", async (c) => {
    const path = c.req.path;
    // Exact asset hit (e.g. /assets/main.js, /favicon.ico).
    const asset = await readAsset(path === "/" ? "index.html" : path);
    if (asset) return asset;
    // SPA fallback: unknown paths without an extension fall back to index.html
    // so the React hash router can handle them.
    if (!/\.[a-z0-9]+$/i.test(path)) {
      const index = await readAsset("index.html");
      if (index) return index;
    }
    return c.text("Not found", 404);
  });

  return app;
}
