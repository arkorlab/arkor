import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
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
import { readManifestSummary } from "./manifest";
import type { HmrCoordinator, HmrEvent } from "./hmr";
import { TrainRegistry, type RestartTarget } from "./trainRegistry";

/** Identify the spawned subprocess to the SPA without exposing it as
 *  a body frame (which would interleave with trainer stdout). The SPA
 *  reads this off `Response.headers` and uses it to scope HMR
 *  `restart` events to the run *this* tab actually started. */
const TRAIN_PID_HEADER = "x-arkor-train-pid";

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

/**
 * Inject the per-launch studio token (always) and an optional HMR
 * feature flag into `<head>`. Both are read by the SPA via
 * `<meta name="...">` lookups — the token gates `/api/*` requests and
 * the HMR flag tells `RunTraining` whether to open
 * `/api/dev/events` (which only exists when `arkor dev` wired in an
 * HMR coordinator). Without the server-side flag the SPA can't tell
 * dev-mode usage from prod-mode usage at runtime: `vite build`'s
 * output ships with `import.meta.env.DEV === false`, so any DEV gate
 * baked into the bundle would suppress HMR even in real `arkor dev`
 * sessions.
 */
function injectStudioMeta(
  html: string,
  token: string,
  hmrEnabled: boolean,
): string {
  const tokenTag = `<meta name="arkor-studio-token" content="${htmlAttrEscape(token)}">`;
  const hmrTag = hmrEnabled
    ? `<meta name="arkor-hmr-enabled" content="true">`
    : "";
  const tags = `${tokenTag}${hmrTag}`;
  const idx = html.indexOf("</head>");
  if (idx === -1) return `${tags}${html}`;
  return `${html.slice(0, idx)}${tags}${html.slice(idx)}`;
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
    // Snapshot the current `configHash` so HMR routing on the *next*
    // rebuild can compare against this child's spawn-time config.
    //
    // When HMR is enabled, read it synchronously from the coordinator
    // (which already maintains `lastEvent.configHash` for its watcher).
    // Reading from the cache avoids triggering an extra `runBuild()`
    // per train request — the previous implementation called
    // `readManifestSummary(trainCwd)` here, which both wasted CPU and
    // raced the watcher writing the same `.arkor/build/index.mjs`.
    //
    // When HMR is disabled the field is irrelevant (no rebuilds will
    // happen) so we leave it null without paying for a build.
    const configHash: string | null = options.hmr
      ? options.hmr.getCurrentConfigHash()
      : null;
    const args = [trainBinPath, "start"];
    if (trainFile) args.push(trainFile);
    // `spawn()` is mostly async (filesystem failures surface as the
    // child's `error` event), but Node can still throw synchronously
    // for argument-shape problems (e.g. invalid stdio descriptor on
    // unusual platforms). Catch both paths so an `/api/train` POST
    // can never hang the SPA — sync throws return a clean 500, async
    // 'error' events forward into the stream and close it (handled
    // inside the ReadableStream `start()` below).
    // `ChildProcessByStdio<Writable, Readable, Readable>` is the
    // specific overload return for `stdio: "pipe"` — narrows
    // `child.stdout` / `child.stderr` away from the nullable
    // `Readable | null` of the general `ChildProcess` type.
    // `ReturnType<typeof spawn>` would land on the union and force
    // a `?.` everywhere downstream.
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(process.execPath, args, {
        stdio: "pipe",
        cwd: trainCwd,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Failed to spawn training subprocess: ${msg}` },
        500,
      );
    }
    activeTrains.register(child, { trainFile, configHash });
    // Hoisted out of the `ReadableStream` underlying-source so the
    // `start` handler can hand its closure-bound teardown helper to
    // the `cancel` handler. `cancel` runs in a separate invocation,
    // not through `controller`, so the two need a parent-scope
    // rendez-vous variable.
    let cancelTeardown: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // After `cancel()` runs, calling `controller.enqueue` /
        // `controller.close` on the now-closed controller throws
        // ("Invalid state: Controller is closed"). The child
        // subprocess keeps emitting `data` and ultimately a `close`
        // event for some time after the client disconnects, so each
        // forwarder needs its own "are we still attached?" guard.
        // Track via a flag plus an explicit listener-removal so the
        // event loop also stops dispatching once we've torn down.
        let closed = false;
        // `child.stdout` is in default (binary) mode, so each `data`
        // chunk is a Buffer — and `Buffer extends Uint8Array`, so we
        // can pass it straight to `controller.enqueue` without a
        // round-trip through `TextEncoder`. The previous code did
        // `enc.encode(d)` which implicitly coerced the buffer via
        // `String()` — same byte content, but allocates a new array.
        const onChunk = (d: Buffer): void => {
          if (closed) return;
          try {
            controller.enqueue(d);
          } catch {
            // Controller raced us into the closed state — flip the
            // flag so subsequent chunks short-circuit.
            closed = true;
          }
        };
        const enc = new TextEncoder();
        // Detach every listener this stream wired onto `child`. Called
        // from `onClose` / `onError` themselves (so once one fires the
        // closure references — controller, TextEncoder — drop and the
        // subprocess record can be GC'd promptly even if the other
        // event also queues), and from `cancelTeardown` for the
        // client-side cancel path. Removing only the `data` listeners
        // (as the previous code did) left `close` / `error` attached
        // to the dead ChildProcess, which kept their closures pinned
        // until the process object itself was reaped — meaningful
        // memory pressure for an `arkor dev` session that spawns many
        // children over hours.
        const detachListeners = (): void => {
          child.stdout.off("data", onChunk);
          child.stderr.off("data", onChunk);
          child.off("close", onClose);
          child.off("error", onError);
        };
        const onClose = (code: number | null): void => {
          activeTrains.unregister(child.pid);
          detachListeners();
          if (closed) return;
          closed = true;
          try {
            controller.enqueue(enc.encode(`\n---\nexit=${code}\n`));
            controller.close();
          } catch {
            // already cancelled; nothing more to do.
          }
        };
        // `error` event fires when async spawn machinery surfaces a
        // failure (ENOENT for the executable, EACCES, EAGAIN under
        // resource exhaustion, etc.). Without this listener the
        // ReadableStream would never close — the SPA would hang
        // waiting for output that never arrives. Forward the error
        // text into the stream body, close, and unregister the
        // child. Node's contract is: if 'error' fires, 'close' may
        // or may not follow — both paths are guarded by the `closed`
        // flag and the `unregister` call is idempotent.
        const onError = (err: Error): void => {
          activeTrains.unregister(child.pid);
          detachListeners();
          if (closed) return;
          closed = true;
          try {
            controller.enqueue(
              enc.encode(`\n---\nerror=${err.message}\n`),
            );
            controller.close();
          } catch {
            // already cancelled; nothing more to do.
          }
        };
        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);
        child.on("close", onClose);
        child.on("error", onError);
        cancelTeardown = () => {
          closed = true;
          detachListeners();
        };
      },
      cancel() {
        // Capture the early-stop flag *before* unregistering: the
        // unregister wipes the entry, after which we can't tell
        // whether HMR's `dispatchRebuild` had already SIGTERMed
        // this child. If it had, sending another SIGTERM here
        // would land as the *second* signal on the runner side and
        // trigger `installShutdownHandlers`' emergency `exit(143)`
        // fast-path — which bypasses the checkpoint-preserving
        // early-stop + cloud `cancel()` flow and can leave the
        // cloud run alive while the local subprocess dies. The HMR
        // path is already driving the child to a clean exit, so we
        // just unregister + detach listeners and let it run.
        const earlyStopInFlight = activeTrains.isEarlyStopRequested(child.pid);
        activeTrains.unregister(child.pid);
        cancelTeardown?.();
        if (earlyStopInFlight) return;
        // `ChildProcess.kill()` can throw (ESRCH if the process has
        // already exited between this handler's invocation and the
        // signal delivery). A throw here would surface as an unhandled
        // exception in the request pipeline and crash the server
        // handler — swallow it; the close handler above has already
        // taken the entry out of the registry.
        try {
          child.kill();
        } catch {
          // already gone; nothing to clean up.
        }
      },
    });
    // Expose the spawned pid via a response header so the SPA can
    // tell its own child apart from other tabs' children when
    // `/api/dev/events` broadcasts `restartTargets` / `hotSwapTargets`.
    // Without this, a passive tab whose run was hot-swapped could
    // misread a sibling tab's restart event as its own.
    const pidHeader = typeof child.pid === "number" ? String(child.pid) : "";
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        [TRAIN_PID_HEADER]: pidHeader,
      },
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
    /** Augmented event = raw HMR event + the per-child signal results we
     *  computed for it. We compute these once per rebuild (not once per
     *  connected SSE client) so opening multiple Studio tabs doesn't fan
     *  out into N × SIGTERM / N × SIGUSR2 to each child. */
    type AugmentedEvent = HmrEvent & {
      restart?: boolean;
      hotSwap?: boolean;
      restartTargets?: RestartTarget[];
      hotSwapTargets?: RestartTarget[];
    };
    const sseListeners = new Set<(event: AugmentedEvent) => void>();
    let lastAugmented: AugmentedEvent | null = null;

    // Single subscription against the HMR coordinator: this handler does
    // signal dispatch + augmentation exactly once per rebuild, then fans
    // the augmented payload out to every connected SSE client. Late-
    // mounting clients receive `lastAugmented` instead of triggering a
    // fresh signal pass against the same rebuild.
    hmr.subscribe((event) => {
      let augmented: AugmentedEvent = event;
      // Route dispatch through every *successful* build event, not
      // just `rebuild`. The coordinator emits the very first
      // successful compile as `ready` (and the entry-wait recovery
      // path also broadcasts `ready` when a fresh-scaffold project's
      // entry file first appears). A child started via `/api/train`
      // before the first `ready` (e.g. the SPA fired Run Training
      // immediately after `arkor dev` booted, while the watcher's
      // initial BUNDLE_END was still in flight) would otherwise
      // never get SIGUSR2/SIGTERM-routed when that build lands —
      // leaving it stuck on a stale or empty artifact until the
      // next edit triggers a `rebuild`. Filtering by "not error"
      // is forward-compatible with any new successful event types.
      if (event.type !== "error" && activeTrains.size > 0) {
        // Single per-child decision pass: hash match → SIGUSR2 (with
        // a Windows fallback to SIGTERM since win32 doesn't deliver
        // SIGUSR2), hash mismatch → SIGTERM. The registry returns
        // both buckets so the SPA can react per-child rather than
        // assuming one global outcome.
        const nextHash = event.configHash ?? null;
        const { hotSwapTargets, restartTargets } =
          activeTrains.dispatchRebuild(nextHash);
        augmented = {
          ...event,
          hotSwap: hotSwapTargets.length > 0,
          hotSwapTargets,
          restart: restartTargets.length > 0,
          restartTargets,
        };
      }
      lastAugmented = augmented;
      for (const fn of sseListeners) {
        try {
          fn(augmented);
        } catch {
          // listener controller closed mid-write — the cancel hook
          // below takes care of removing it from the set.
        }
      }
    });

    app.get("/api/dev/events", () => {
      const enc = new TextEncoder();
      let listener: ((event: AugmentedEvent) => void) | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: AugmentedEvent): void => {
            const payload = JSON.stringify(event);
            try {
              controller.enqueue(
                enc.encode(`event: ${event.type}\ndata: ${payload}\n\n`),
              );
            } catch {
              // controller closed mid-write; cancel() removes us.
            }
          };
          if (lastAugmented) send(lastAugmented);
          listener = send;
          sseListeners.add(send);
        },
        cancel() {
          if (listener) sseListeners.delete(listener);
          listener = null;
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
        const html = injectStudioMeta(
          file.toString("utf8"),
          studioToken,
          Boolean(options.hmr),
        );
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
