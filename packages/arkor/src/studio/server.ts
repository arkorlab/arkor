import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@arkor/cloud-api-client";
import { Hono } from "hono";

import { CloudApiClient, CloudApiError } from "../core/client";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
  writeCredentials,
  requestAnonymousToken,
  type Credentials,
} from "../core/credentials";
import {
  recordDeprecation,
  tapDeprecation,
  type DeprecationNotice,
} from "../core/deprecation";
import {
  AUTH0_MISSING_STATE_MESSAGE,
  ensureProjectState,
} from "../core/projectState";
import { resolveBuildEntry } from "../core/rolldownConfig";
import {
  createDeploymentKeyRequestSchema,
  createDeploymentRequestSchema,
} from "../core/schemas";
import { readState } from "../core/state";
import { SDK_VERSION } from "../core/version";

import { readManifestSummary } from "./manifest";
import { TrainRegistry, type RestartTarget } from "./trainRegistry";

import type { HmrCoordinator, HmrEvent } from "./hmr";
import type { Readable, Writable } from "node:stream";

/** Identify the spawned subprocess to the SPA without exposing it as
 *  a body frame (which would interleave with trainer stdout). The SPA
 *  reads this off `Response.headers` and uses it to scope HMR
 *  `restart` events to the run *this* tab actually started. */
const TRAIN_PID_HEADER = "x-arkor-train-pid";
/**
 * Build the per-spawn match for the runner's `[arkor:<nonce>] Started job <id>` marker.
 *
 * `core/runner.ts` prefixes that text with the per-spawn nonce we
 * inject via `ARKOR_JOB_ID_MARKER_NONCE`; without the prefix, a
 * user `console.log("Started job <attacker-id>")` from inside
 * `trainer.start()` / `onCheckpoint` / etc. could land in stdout
 * *before* the runner's real line and we'd record the wrong id, so
 * Stop-training would then POST `/v1/jobs/:attacker-id/cancel`
 * against a job the attacker chose. Anchoring on a 32-hex nonce
 * shared by the server + runner (the env var is deleted by
 * runner.ts BEFORE the user module is dynamically imported, so the
 * user can't read it via `process.env`) closes the casual-spoof
 * hole. Not hermetic, though: the exec-time environment block is
 * still recoverable in-process via `/proc/self/environ` (or `ps
 * eww` by any same-user process) on Linux, so a determined
 * malicious dependency could reconstruct the prefix; see the
 * threat-model note on `STARTED_JOB_NONCE` in `core/runner.ts`.
 *
 * Pattern is per-spawn because the nonce is per-spawn.
 *
 * The match is intentionally NOT anchored at line start (`^`): user
 * or runtime code that writes to stdout WITHOUT a trailing newline
 * before `trainer.start()` resolves (`process.stdout.write(...)`
 * progress, carriage-return rewrites) gets concatenated onto the
 * same line as the runner's marker. A line-start anchor would then
 * skip the marker entirely, leave `parsedJobId` null, and let
 * manual Stop SIGKILL the child without firing the cloud cancel
 * POST (orphaned remote job). The nonce prefix is the real trust
 * anchor; the `$` end-anchor still pins the captured id to the
 * line's tail and the `(\S+)` capture mirrors the runner's exact
 * write shape (cloud-api job ids never contain whitespace).
 */
function buildStartedJobPattern(nonce: string): RegExp {
  // Nonce is a 32-char hex string from `randomBytes(16).toString("hex")`,
  // i.e. only `[0-9a-f]` (safe to interpolate into the regex literal).
  return new RegExp(String.raw`\[arkor:${nonce}\] Started job (\S+)$`);
}

const DEPRECATION_HEADERS = ["Deprecation", "Sunset", "Warning"] as const;
function copyDeprecationHeaders(from: Headers, to: Headers): void {
  for (const name of DEPRECATION_HEADERS) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
}

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

const HTML_ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function htmlAttrEscape(s: string): string {
  return s.replaceAll(/[&<>"']/g, (ch) => HTML_ATTR_ESCAPES[ch] ?? ch);
}

/**
 * Inject the per-launch studio token (always) and an optional HMR
 * feature flag into `<head>`. Both are read by the SPA via
 * `<meta name="...">` lookups: the token gates `/api/*` requests and
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

function tokenFromCredentials(c: Credentials): string {
  return c.mode === "anon" ? c.token : c.accessToken;
}

function createRpc(rpcBaseUrl: string, rpcToken: string) {
  return createClient({
    baseUrl: rpcBaseUrl,
    // `createClient` expects a token-getter (the SDK supports
    // refreshable tokens). The whole point of taking `rpcToken` here
    // is to avoid the per-request second credentials read that the
    // previous closure-based getter caused, so resolve the in-memory
    // value synchronously instead of re-deriving it.
    token: () => rpcToken,
    clientVersion: SDK_VERSION,
    // The wrapper around `recordDeprecation` works around the same
    // alpha.2 bug documented in `core/client.ts`: upstream guards
    // `.then(...)` with `result !== null && typeof result.then ===
    // "function"`, but the inner `.then` probe still throws on a
    // `void` return and the surrounding try/catch logs every
    // deprecated response as a "handler threw" entry. Returning
    // `null` short-circuits the left side of the `&&` so the probe
    // never runs and the spurious log goes away.
    onDeprecation: (notice) => {
      recordDeprecation(notice);
      return null;
    },
  });
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
  // directory up: `../bin.mjs` would resolve to the package root.
  const trainBinPath =
    options.binPath ?? fileURLToPath(new URL("bin.mjs", import.meta.url));

  if (!studioToken || studioToken.length < 16) {
    throw new Error(
      "buildStudioApp requires a studioToken with at least 16 characters of entropy.",
    );
  }

  const app = new Hono();

  const loopbackHostPattern = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/;
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
  //      and reach the handler. The token check rejects those: an attacker
  //      page can't read the SPA's <meta> from another origin.
  //   2. `?studioToken=` is accepted only on the GET stream-only routes
  //      allowlisted in `eventStreamPathPattern` above (currently the
  //      job-events stream and `/api/dev/events`), because `EventSource`
  //      cannot send custom headers. Mutation routes require the header
  //      so a leaked token in a URL is not enough to POST. Keep this
  //      list in sync with `eventStreamPathPattern`; widening it is
  //      CSRF-sensitive (see the comment on the pattern).
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

  /**
   * Load credentials and resolve the cloud API base URL from them.
   * `defaultArkorCloudApiUrl(credentials)` picks `ARKOR_CLOUD_API_URL`
   * env first, then the URL stamped onto the credentials at signup
   * (anonymous) or login (OAuth, since round 67), then production.
   * This is the supported way for every Studio route to follow the
   * control plane the credentials came from: the closure-captured
   * `baseUrl` only knows the env / production fallback (no creds at
   * startup), so an OAuth user who logged in against staging without
   * setting the env var would otherwise see Jobs / Playground /
   * identity 401 against production while only the deployments proxy
   * (which already resolves per-request) reaches the right host.
   *
   * Returns the bearer token alongside `credentials` so callers don't
   * have to thread `tokenFromCredentials` themselves; passing the
   * resolved token straight into `createRpc()` keeps each request to a
   * single credentials read instead of one read here plus another via
   * the SDK's `token` callback at fetch time.
   */
  async function resolveCredentialsAndBaseUrl(): Promise<{
    credentials: Credentials;
    token: string;
    baseUrl: string;
  }> {
    const credentials = await getCredentials();
    return {
      credentials,
      token: tokenFromCredentials(credentials),
      baseUrl: defaultArkorCloudApiUrl(credentials),
    };
  }

  // ---- API routes ---------------------------------------------------------

  app.get("/api/credentials", async (c) => {
    const {
      credentials: creds,
      token,
      baseUrl: credsBaseUrl,
    } = await resolveCredentialsAndBaseUrl();
    const state = await readState(trainCwd);
    return c.json({
      token,
      mode: creds.mode,
      // Surface the credentials-derived URL (auth-time host) so the SPA
      // identity chip + any debugger that reads this endpoint reflects
      // the *actual* control plane the session talks to, not the
      // startup-time fallback that `arkor dev` was launched with.
      baseUrl: credsBaseUrl,
      orgSlug: state?.orgSlug ?? (creds.mode === "anon" ? creds.orgSlug : null),
      projectSlug: state?.projectSlug ?? null,
    });
  });

  app.get("/api/me", async () => {
    const { token, baseUrl: credsBaseUrl } =
      await resolveCredentialsAndBaseUrl();
    const rpc = createRpc(credsBaseUrl, token);
    const res = await rpc.v1.me.$get();
    const body = await res.text();
    const headers = new Headers({ "content-type": "application/json" });
    copyDeprecationHeaders(res.headers, headers);
    return new Response(body, { status: res.status, headers });
  });

  // Pre-resolved outFile for the HMR fast path. The path is
  // deterministic per cwd (defaults from `BUILD_DEFAULTS`), so we
  // compute it once at app build time rather than on every request.
  // Only used when HMR is enabled; `readManifestSummary` falls
  // back to `runBuild()` when this is undefined or the file doesn't
  // exist yet (fresh scaffold pre-watcher-bootstrap).
  const hmrOutFile = options.hmr
    ? resolveBuildEntry({ cwd: trainCwd }).outFile
    : undefined;
  app.get("/api/manifest", async (c) => {
    try {
      // Surface watcher build errors directly. Without this gate the
      // HMR fast path below would happily serve the LAST GOOD
      // artefact even when the user's current source fails to
      // compile: `RunTraining` polls `/api/manifest` every ~5 s, so
      // the next poll after a compile error would 200 with stale
      // data and silently overwrite the SSE-surfaced error UI.
      // Users would then see a "healthy" trainer in the manifest
      // and unknowingly run stale code/config while the latest
      // edit is still broken. Rejecting with the SSE error message
      // keeps the SPA's error state consistent across both
      // channels (poll + SSE).
      if (options.hmr?.getLastEventType() === "error") {
        return c.json({ error: "Build failed; see HMR error frame" }, 400);
      }
      // HMR-aware fast path: when `arkor dev` wired in a coordinator,
      // skip the per-request `runBuild()` and read the watcher's
      // already-built artefact. Without this every SPA poll
      // (~5 s + per-rebuild SSE refetch) would re-bundle and race
      // the watcher writing to the same `.arkor/build/index.mjs`.
      const manifest = await readManifestSummary(trainCwd, {
        prebuiltOutFile: hmrOutFile,
      });
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
    const { token, baseUrl: credsBaseUrl } =
      await resolveCredentialsAndBaseUrl();
    const rpc = createRpc(credsBaseUrl, token);
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
    const { token, baseUrl: credsBaseUrl } =
      await resolveCredentialsAndBaseUrl();
    const url = `${credsBaseUrl}/v1/jobs/${encodeURIComponent(id)}/events/stream?orgSlug=${encodeURIComponent(state.orgSlug)}&projectSlug=${encodeURIComponent(state.projectSlug)}`;
    // Read once and forward only when truthy: an empty
    // `Last-Event-ID: ` header is semantically ambiguous upstream and
    // historically the proxy treated empty as "header absent", so a
    // bare `!== undefined` check would silently change behaviour for
    // clients that ship the header with an empty value.
    const lastEventId = c.req.header("Last-Event-ID");
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Arkor-Client": `arkor/${SDK_VERSION}`,
        Accept: "text/event-stream",
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
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
  // signal-dispatch policy (see `studio/trainRegistry.ts`).
  const activeTrains = new TrainRegistry();

  app.post("/api/train", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { file?: string };
    let trainFile: string | undefined;
    if (body.file) {
      // Resolve symlinks before the containment check: `path.resolve` is purely
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
    // per train request: the previous implementation called
    // `readManifestSummary(trainCwd)` here, which both wasted CPU and
    // raced the watcher writing the same `.arkor/build/index.mjs`.
    //
    // When HMR is disabled the field is irrelevant (no rebuilds will
    // happen) so we leave it null without paying for a build.
    //
    // CUSTOM-ENTRY GUARD: when `body.file` was provided, both hashes
    // below are forced to null even under HMR. The coordinator's
    // hashes describe the DEFAULT entry's bundle, but `arkor start
    // <file>` rebuilds `.arkor/build/index.mjs` from the custom entry
    // and runs THAT trainer. Recording the default entry's configHash
    // as this child's baseline would let a later same-hash rebuild
    // SIGUSR2 a hot-swap that injects the default trainer's callbacks
    // into the custom trainer's live run. Null baselines route every
    // rebuild through the conservative SIGTERM-restart path instead.
    // (This route is currently unreachable from the SPA, which never
    // sets `file`; direct API users get the safe behaviour.) Known
    // residual wart, accepted for now: the custom-entry rebuild still
    // writes the watcher-owned outFile, so the manifest fast path can
    // transiently describe the custom bundle until the watcher's next
    // publish restores the default artefact.
    const configHash: string | null =
      options.hmr && !trainFile ? options.hmr.getCurrentConfigHash() : null;
    // Spawn-time CONTENT-hash of the on-disk build artefact. Only
    // the pre-ready-spawn case in `dispatchRebuild` consults it:
    // when a rebuild lands while the child's `configHash` is still
    // null, backfilling the new hash is only safe if the artefact
    // bytes the child loaded (= the bytes on disk *now*, at spawn)
    // are the same bytes the new hash describes. Without this
    // gate, an edit landing between spawn and the watcher's first
    // BUNDLE_END would silently align the registry with a config
    // the child never actually loaded → cloud-side `JobConfig`
    // drift on subsequent same-hash hot-swaps.
    //
    // Content (sha256) rather than mtime+ctime+size: the
    // timestamp version had a false-positive failure mode where a
    // watcher rebuild that produced identical bytes still bumped
    // mtime/ctime, forcing a spurious cancel+restart cycle on a
    // pre-ready spawn even though the child's loaded bytes
    // actually matched the new build. Content-hash is precise.
    //
    // Same custom-entry guard as `configHash` above: a non-null
    // content hash would arm the pre-ready-spawn backfill, which is
    // only sound when the child loaded the default entry's artefact.
    const spawnArtifactContentHash: string | null =
      options.hmr && !trainFile
        ? options.hmr.getCurrentArtifactContentHash()
        : null;
    // Capture the cloud-api scope NOW (at spawn time) so the cancel
    // handler can POST `/v1/jobs/:id/cancel` without re-reading
    // `.arkor/state.json` at stop time. If the user removed or made
    // the state file unreadable mid-training, the stop-time read
    // would return null and the cancel POST would silently skip:
    // local SIGKILL still tears down the subprocess but the cloud
    // run orphans. Pinning the scope on the registry entry when it
    // exists decouples cancel correctness from mutable filesystem state.
    //
    // `spawnScope` may legitimately be `null` on a first-run anonymous
    // project: `.arkor/state.json` is created by `ensureProjectState`
    // INSIDE the child during `trainer.start()`, i.e. AFTER spawn but
    // possibly before the user clicks Stop. The cancel handler treats
    // a null registry scope as a signal to fall back to reading
    // `.arkor/state.json` at cancel time (the file should exist by
    // then because the runner emits its `Started job <id>` line AFTER
    // `trainer.start()` resolved, which is the same point at which
    // `ensureProjectState` has finished writing the state file). The
    // delete-mid-training hazard the spawn-time capture exists to
    // close only applies when the SPAWN read succeeded; once we have
    // a non-null capture we never re-read.
    const spawnState = await readState(trainCwd);
    const spawnScope = spawnState
      ? { orgSlug: spawnState.orgSlug, projectSlug: spawnState.projectSlug }
      : null;
    // Capture credentials + base URL at spawn time too (Codex P2,
    // round 80): the child creates the cloud job with whatever
    // credentials it loads at `trainer.start()`, milliseconds after
    // this spawn. If the user logs in/out (or switches control
    // planes) while the run is in flight, a cancel-time credentials
    // read would address the cancel POST to the NEW account/host;
    // the POST 404s (or cancels an unrelated job), the failure is
    // swallowed as best-effort, and the ORIGINAL cloud job keeps
    // running after the SIGKILL. Snapshotting here pins the cancel
    // to the same identity the child used. Read directly via
    // `readCredentials()` (not `getCredentials()`) so a fresh
    // machine without credentials doesn't trigger a blocking
    // anonymous-bootstrap network call on the spawn path; the
    // cancel handler falls back to a cancel-time resolve when this
    // capture is null.
    const spawnCreds = await readCredentials();
    const spawnRpc = spawnCreds
      ? {
          baseUrl: defaultArkorCloudApiUrl(spawnCreds),
          token: tokenFromCredentials(spawnCreds),
        }
      : null;
    const args = [trainBinPath, "start"];
    if (trainFile) args.push(trainFile);
    // Per-spawn 16-byte nonce passed via env var so the runner can
    // prefix its `Started job <id>` line with `[arkor:<nonce>] `. The
    // server matches that nonce-prefixed shape (see
    // `buildStartedJobPattern` for why). 32-hex chars of entropy
    // guarantees a user-code spoof attempt can't guess the prefix in
    // a single shot, and `core/runner.ts` deletes the env var BEFORE
    // dynamically importing the user module so user code can't read
    // it via `process.env` either.
    const startedJobNonce = randomBytes(16).toString("hex");
    const startedJobPattern = buildStartedJobPattern(startedJobNonce);
    // `spawn()` is mostly async (filesystem failures surface as the
    // child's `error` event), but Node can still throw synchronously
    // for argument-shape problems (e.g. invalid stdio descriptor on
    // unusual platforms). Catch both paths so an `/api/train` POST
    // can never hang the SPA: sync throws return a clean 500, async
    // 'error' events forward into the stream and close it (handled
    // inside the ReadableStream `start()` below).
    // `ChildProcessByStdio<Writable, Readable, Readable>` is the
    // specific overload return for `stdio: "pipe"`; narrows
    // `child.stdout` / `child.stderr` away from the nullable
    // `Readable | null` of the general `ChildProcess` type.
    // `ReturnType<typeof spawn>` would land on the union and force
    // a `?.` everywhere downstream.
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(process.execPath, args, {
        stdio: "pipe",
        cwd: trainCwd,
        env: {
          ...process.env,
          ARKOR_JOB_ID_MARKER_NONCE: startedJobNonce,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Failed to spawn training subprocess: ${msg}` },
        500,
      );
    }
    activeTrains.register(child, {
      trainFile,
      configHash,
      spawnArtifactContentHash,
      scope: spawnScope,
      // Same snapshot the manual-Stop cancel path uses via the
      // `spawnRpc` closure; pinned on the registry entry so the
      // win32 HMR-restart cancel loop (which has no access to this
      // request's closures) can address its cancel POST with the
      // identity the child actually used.
      rpc: spawnRpc,
    });
    // Hoisted out of the `ReadableStream` underlying-source so the
    // `start` handler can hand its closure-bound teardown helper to
    // the `cancel` handler. `cancel` runs in a separate invocation,
    // not through `controller`, so the two need a parent-scope
    // rendez-vous variable.
    let cancelTeardown: (() => void) | null = null;
    // Mirror of the cloud `jobId` parsed out of the runner's
    // stdout, accessible to both the `start` (parser writes) and
    // `cancel` (post-unregister read) handlers. We can't just call
    // `activeTrains.getJobId(pid)` from `cancel` because cancel
    // unregisters the entry first, so subsequent reads of the
    // registry would always be `null` even if the parser races a
    // late line in afterwards. This closure variable keeps the id
    // observable even after unregister, so the cancel POST poll
    // below can pick up a jobId that lands a few ms after Stop.
    let parsedJobId: string | null = null;
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
        // chunk is a Buffer, and `Buffer extends Uint8Array`, so we
        // can pass it straight to `controller.enqueue` without a
        // round-trip through `TextEncoder`. The previous code did
        // `enc.encode(d)` which implicitly coerced the buffer via
        // `String()`: same byte content, but allocates a new array.
        // Forward a chunk to the SPA stream. Shared between the
        // stdout and stderr listeners; both paths surface as
        // request body bytes for the SPA's log view.
        const forward = (d: Buffer): void => {
          if (closed) return;
          try {
            controller.enqueue(d);
          } catch {
            // Controller raced us into the closed state; flip the
            // flag so subsequent chunks short-circuit.
            closed = true;
          }
        };
        // Carry-over buffer for line-oriented job-id extraction.
        // Stream chunk boundaries are arbitrary: the runner's
        // single-line `Started job <id>` write can land split
        // across two `data` events, in which case a per-chunk
        // regex would never match and the cancel POST chain
        // would never fire (cloud-job orphan on Stop). We
        // accumulate text until a newline, parse the complete
        // line, and keep any trailing partial for the next
        // chunk. Cleared the moment the id is recorded so a
        // chatty bin doesn't pin memory after the marker has
        // landed; capped at 4 KiB regardless to bound a
        // misbehaving bin that never emits a newline before the
        // marker (the canonical line is well under 100 bytes).
        let stdoutLineBuf = "";
        const STARTED_JOB_BUFFER_CAP = 4096;
        // STDOUT-ONLY job-id parser. The runner writes the canonical
        // `Started job <id>` line via `process.stdout.write` (never
        // stderr), so a single shared buffer across both pipes
        // would mis-match in two ways:
        //   1. A user `console.error("Started job <token>")` would
        //      poison the buffer first; the real stdout marker
        //      arrives later but our `getJobId(...) === null` gate
        //      has already short-circuited subsequent scans, so
        //      Stop-training POSTs cancel for the wrong (or
        //      non-existent) job.
        //   2. Interleaved stderr bytes could land between
        //      "Started job " and "<id>\n" in the shared buffer,
        //      breaking the anchored line match → missed match →
        //      cloud cancel skipped on Stop.
        // Two dedicated handlers share `forward` for the byte
        // pipeline but only the stdout one runs the parse.
        const onStdoutChunk = (d: Buffer): void => {
          // Intentionally NOT gated on `closed`: when the SPA cancels,
          // `cancelTeardown()` flips `closed = true` so the controller
          // path no-ops, but the cancel IIFE then POLLS `parsedJobId`
          // for up to 500 ms to catch a `Started job <id>` line that
          // landed just after the user clicked Stop. The parser has to
          // keep running during that window for the poll to ever
          // observe a value. (`forward()` has its own `closed` check
          // for the controller-enqueue side, so the SSE-body path
          // stays sealed.) Gate the parse on `parsedJobId === null`
          // (not `activeTrains.getJobId(...) === null`): the latter
          // returns null forever after `unregister`, which would make
          // us re-enter and re-parse the buffer on every subsequent
          // chunk during the poll window.
          if (parsedJobId === null) {
            stdoutLineBuf += d.toString("utf8");
            let nl = stdoutLineBuf.indexOf("\n");
            while (nl !== -1) {
              // Strip a possible \r so CRLF-emitting bins (rare for
              // Node `process.stdout.write` but defensive) match
              // the same anchored pattern.
              const line = stdoutLineBuf.slice(0, nl).replace(/\r$/, "");
              stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
              const m = startedJobPattern.exec(line);
              if (m?.[1]) {
                activeTrains.recordJobId(child.pid, m[1]);
                // Mirror to the parent-scope closure so the cancel
                // handler can pick this up even AFTER it called
                // `activeTrains.unregister(...)` (the registry
                // read would return null post-unregister).
                parsedJobId = m[1];
                stdoutLineBuf = "";
                break;
              }
              nl = stdoutLineBuf.indexOf("\n");
            }
            if (stdoutLineBuf.length > STARTED_JOB_BUFFER_CAP) {
              stdoutLineBuf = stdoutLineBuf.slice(-STARTED_JOB_BUFFER_CAP);
            }
          }
          forward(d);
        };
        const onStderrChunk = (d: Buffer): void => {
          // Forward only; never scan for `Started job`. See
          // `onStdoutChunk` comment for the cross-stream poisoning
          // hazards this split prevents.
          forward(d);
        };
        const enc = new TextEncoder();
        // Detach every listener this stream wired onto `child`. Called
        // from `onClose` / `onError` themselves (so once one fires the
        // closure references (controller, TextEncoder) drop and the
        // subprocess record can be GC'd promptly even if the other
        // event also queues), and from `cancelTeardown` for the
        // client-side cancel path. Removing only the `data` listeners
        // (as the previous code did) left `close` / `error` attached
        // to the dead ChildProcess, which kept their closures pinned
        // until the process object itself was reaped: meaningful
        // memory pressure for an `arkor dev` session that spawns many
        // children over hours.
        const detachListeners = (): void => {
          child.stdout.off("data", onStdoutChunk);
          child.stderr.off("data", onStderrChunk);
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
        // ReadableStream would never close; the SPA would hang
        // waiting for output that never arrives. Forward the error
        // text into the stream body, close, and unregister the
        // child. Node's contract is: if 'error' fires, 'close' may
        // or may not follow; both paths are guarded by the `closed`
        // flag and the `unregister` call is idempotent.
        const onError = (err: Error): void => {
          activeTrains.unregister(child.pid);
          detachListeners();
          if (closed) return;
          closed = true;
          try {
            controller.enqueue(enc.encode(`\n---\nerror=${err.message}\n`));
            controller.close();
          } catch {
            // already cancelled; nothing more to do.
          }
        };
        child.stdout.on("data", onStdoutChunk);
        child.stderr.on("data", onStderrChunk);
        child.on("close", onClose);
        child.on("error", onError);
        cancelTeardown = () => {
          // Don't detach data listeners here: the child stays alive
          // for some time after the SPA cancels, either because
          // we're skipping `child.kill()` for an in-progress
          // HMR early-stop, or because `child.kill()`'s SIGTERM
          // triggers a graceful checkpoint+exit that takes
          // seconds. During that window the child keeps writing
          // logs to its stdout/stderr pipes; if our `data`
          // listeners are gone, Node stops draining the OS pipe,
          // the buffer fills, and the child's next `write()`
          // blocks indefinitely, deadlocking the very graceful
          // exit we're trying to preserve. The `closed` flag
          // already makes `enqueue`/`close` a no-op so the
          // controller-closed race stays safe; the eventual
          // `onClose` / `onError` listeners detach everything
          // (via `detachListeners()`) when the child finally
          // exits. That timing (at-exit, not at-cancel) is the
          // correct moment to break the closure refs for GC.
          closed = true;
        };
      },
      cancel() {
        // The SPA-side cancel is always *user-initiated*: either an
        // explicit Stop click or tab-close/navigation, which the
        // user just as explicitly chose. HMR-driven SIGTERMs go
        // straight from the server to the runner via
        // `dispatchRebuild`; they DO NOT trigger this handler
        // (the SPA waits for the train stream's `exit=` line and
        // schedules auto-restart, never aborting). So manual stop
        // takes precedence over any in-flight HMR graceful path:
        // we POST cloud cancel + SIGKILL unconditionally.
        //
        // SIGKILL is uncatchable so the long-standing
        // "second-SIGTERM-triggers-exit(143)-fast-path" worry
        // (which used to gate this branch on
        // `isEarlyStopRequested`) doesn't apply. The runner's
        // graceful early-stop chain may have been trying to
        // preserve a checkpoint, but the user just said no; keep
        // the local subprocess teardown snappy and let the
        // server-side cancel POST handle the cloud-side release.
        //
        // Capture the cloud job id + spawn-time scope BEFORE
        // unregistering: once the entry is gone, the getters
        // return null and the fire-and-forget POST below would
        // no-op.
        //
        // `pid` is captured once here because the closure below
        // runs after `unregister` and we want a stable handle.
        const cancelPid = child.pid;
        // Scope resolution order:
        //   1. Registry entry's pinned scope (captured at spawn time).
        //      Authoritative when non-null: a user who deleted or made
        //      `.arkor/state.json` unreadable AFTER spawn shouldn't be
        //      able to silently orphan their cloud job by losing the
        //      cancel-time read.
        //   2. Cancel-time re-read of `.arkor/state.json`, ONLY when
        //      the spawn-time capture was null. This handles the
        //      first-run anon case where `ensureProjectState` writes
        //      the state file from inside the child during
        //      `trainer.start()` (i.e. AFTER spawn). The read happens
        //      inside the fire-and-forget IIFE below so the cancel
        //      handler stays sync.
        const pinnedScope = activeTrains.getScope(cancelPid);
        activeTrains.unregister(cancelPid);
        cancelTeardown?.();
        // Fire-and-forget cloud-side cancel so the cloud job is
        // released even though the SIGKILL below bypasses the
        // runner's `installShutdownHandlers` (which would
        // otherwise issue cancel itself via the graceful
        // early-stop chain). The IIFE polls for the jobId
        // *briefly* before giving up: there's a real race
        // window where the user clicks Stop after the cloud
        // job has been created but before the runner's
        // `Started job <id>` line has been parsed (cloud
        // createJob roundtrip is ~50-200ms; UI clicks can land
        // sub-100ms into that window). Polling closes the most
        // common case; beyond ~500 ms we accept the cloud-side
        // orphan as a follow-up (the cloud reaper / TTL is the
        // safety net, and the alternative of querying cloud-api
        // for matching jobs at cancel time is brittle in
        // multi-tab/multi-spawn scenarios).
        void (async () => {
          // Brief poll on `parsedJobId` (the closure mirror,
          // see top-of-handler for why it can't be the
          // registry's `getJobId`): the runner's
          // `Started job <id>` line may not have been parsed by
          // the time the user clicked Stop. Most runs hit it
          // within ~50-200 ms of spawn (cloud createJob
          // roundtrip), so polling for up to ~500 ms catches
          // nearly all races. Beyond that we accept the
          // cloud-side orphan as a documented follow-up: cloud
          // reaper / TTL is the safety net, and the
          // alternative (querying cloud-api for matching jobs
          // at cancel time) is brittle for multi-tab /
          // multi-spawn cases.
          if (parsedJobId === null) {
            const start = Date.now();
            // `parsedJobId` is mutated by the stdout parser closure
            // while we await below; TS's flow analysis narrows it to
            // `null` here (it can't see the cross-closure write across
            // the await) and `no-unnecessary-condition` mis-reports the
            // loop guard as always-true. The poll is real: the marker
            // line can land mid-wait.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            while (parsedJobId === null && Date.now() - start < 500) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          if (parsedJobId === null) return;
          // Resolve the cloud scope: prefer the spawn-time
          // capture (immutable, snapshot at spawn) and fall back
          // to reading `.arkor/state.json` only when there was
          // none. The state file usually exists by now: the
          // runner doesn't print `Started job <id>` until
          // `trainer.start()` resolves, and `ensureProjectState`
          // (which writes the file from inside the child for
          // first-run anon projects) runs as part of that path.
          let scopeForCancel = pinnedScope;
          if (!scopeForCancel) {
            try {
              const late = await readState(trainCwd);
              if (late) {
                scopeForCancel = {
                  orgSlug: late.orgSlug,
                  projectSlug: late.projectSlug,
                };
              }
            } catch {
              // best-effort
            }
          }
          if (!scopeForCancel) return;
          try {
            // Prefer the spawn-time credential snapshot so the cancel
            // POST hits the same account/control-plane the child used
            // for createJob (see `spawnRpc` capture above). Fall back
            // to a cancel-time resolve only when there were no
            // credentials on disk at spawn (first-run anon flow: the
            // child bootstrapped them itself, and the file the
            // resolve reads here is the one that child wrote).
            const { baseUrl: rpcBaseUrl, token: rpcToken } =
              spawnRpc ?? (await resolveCredentialsAndBaseUrl());
            const rpc = createRpc(rpcBaseUrl, rpcToken);
            await rpc.v1.jobs[":id"].cancel.$post({
              param: { id: parsedJobId },
              query: {
                orgSlug: scopeForCancel.orgSlug,
                projectSlug: scopeForCancel.projectSlug,
              },
            });
          } catch {
            // Best-effort: cloud-api transient failure or scope
            // drift. Cloud reaper / TTL is the safety net.
          }
        })();
        // SIGKILL (not the default SIGTERM) for user-initiated
        // aborts. The runner's `installShutdownHandlers` now treats
        // a single SIGTERM as the HMR-driven "graceful early-stop"
        // signal: wait for the next checkpoint (up to ~5 min
        // timeout) before exiting. That semantics is right for the
        // HMR path but wrong for a Stop-training click: the user
        // wants the run STOPPED, not left running in the background
        // for minutes consuming GPU/cloud spend while the UI has
        // already settled to idle. SIGKILL is uncatchable so the
        // child dies immediately, eliminating the
        // unregister-before-graceful-exit window where a fast new
        // run could overlap an old one untracked by HMR routing.
        //
        // The cloud-side job is released by the fire-and-forget
        // POST above (we recorded the runner's `Started job <id>`
        // line on the registry; the IIFE looks it up here). SIGKILL
        // alone would have left the cloud job orphaned until
        // TTL/reaper because the runner can't POST cancel itself
        // when the kernel reaps it without warning. Together,
        // server-side cancel POST + SIGKILL give snappy local
        // teardown AND eventual cloud-side release.
        //
        // `ChildProcess.kill()` can throw (ESRCH if the process has
        // already exited between this handler's invocation and the
        // signal delivery). A throw here would surface as an unhandled
        // exception in the request pipeline and crash the server
        // handler. Swallow it; the close handler above has already
        // taken the entry out of the registry.
        try {
          child.kill("SIGKILL");
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
    //
    // Header is OMITTED entirely (rather than sent as an empty
    // string) when `child.pid` isn't a number; that case happens
    // when the OS hasn't assigned a pid by the time `spawn()`
    // returns and the child's async `error` event will fire shortly
    // (per-Node-docs `subprocess.pid` is `undefined` for
    // failed-spawn children). "Header absent" is the unambiguous
    // signal the SPA can read; an empty string would force callers
    // to special-case `""` vs missing for the same condition. The
    // SPA's `raw ? Number.parseInt(raw, 10) : NaN` handler treats
    // both cases identically, but absent-only is the cleaner wire
    // contract.
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
    };
    if (typeof child.pid === "number") {
      headers[TRAIN_PID_HEADER] = String(child.pid);
    }
    return new Response(stream, { status: 200, headers });
  });

  // `/api/dev/events`: SSE stream of HMR rebuild / error notifications.
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
      // never get SIGUSR2/SIGTERM-routed when that build lands,
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
        // Content-hash for the pre-ready-spawn equality gate (the
        // timestamp `event.hash` would over-trigger SIGTERM-restart
        // on identical-bytes rebuilds). Both sides of the
        // comparison (`entry.spawnArtifactContentHash` captured
        // via `getCurrentArtifactContentHash()`, and this
        // `event.contentHash`) are derived the same way, so a
        // match means the child's loaded bytes ARE what the new
        // configHash describes.
        const nextArtifactContentHash = event.contentHash ?? null;
        // win32 (Codex P1, round 81): Node's `subprocess.kill("SIGTERM")`
        // on Windows terminates the child "forcefully and abruptly"
        // (per Node's child_process docs), so the runner's
        // `installShutdownHandlers` never runs and the child can't
        // issue its own graceful `cancel()` POST. Snapshot each active
        // child's parsed jobId + spawn scope BEFORE dispatch (after
        // dispatch the kill may already be reaping entries via close
        // handlers) so the server can fire the cloud cancel on the
        // child's behalf for every restart target.
        const win32CancelSnapshots =
          process.platform === "win32"
            ? activeTrains.list().map((entry) => ({
                pid: entry.child.pid,
                jobId: entry.jobId,
                scope: entry.scope,
                // Narrow getter, not an entry field: `list()`
                // snapshots must not carry bearer tokens.
                rpc: activeTrains.getRpcSnapshot(entry.child.pid),
              }))
            : [];
        const { hotSwapTargets, restartTargets } = activeTrains.dispatchRebuild(
          nextHash,
          nextArtifactContentHash,
        );
        if (process.platform === "win32" && restartTargets.length > 0) {
          for (const target of restartTargets) {
            const snap = win32CancelSnapshots.find((s) => s.pid === target.pid);
            if (!snap?.jobId || !snap.scope) continue;
            const { jobId: snapJobId, scope: snapScope } = snap;
            // Fire-and-forget per child, mirroring the manual-Stop
            // cancel path: SIGTERM-as-forceful-kill on win32 means
            // nobody else will release the cloud job. Best-effort;
            // cloud reaper / TTL is the safety net on failure.
            const snapRpc = snap.rpc;
            void (async () => {
              try {
                // Prefer the spawn-time credential snapshot (qodo,
                // round 83), mirroring the manual-Stop cancel path:
                // a login / control-plane switch mid-run would make
                // a cancel-time credentials read address this POST
                // to the wrong account/host, silently orphaning the
                // original cloud job. Fall back to a cancel-time
                // resolve only when no credentials existed at spawn
                // (first-run anon: the child bootstrapped them, and
                // the file read here is the one it wrote).
                const { baseUrl: rpcBaseUrl, token: rpcToken } =
                  snapRpc ?? (await resolveCredentialsAndBaseUrl());
                const rpc = createRpc(rpcBaseUrl, rpcToken);
                await rpc.v1.jobs[":id"].cancel.$post({
                  param: { id: snapJobId },
                  query: {
                    orgSlug: snapScope.orgSlug,
                    projectSlug: snapScope.projectSlug,
                  },
                });
              } catch {
                // best-effort
              }
            })();
          }
        }
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
          // listener controller closed mid-write; the cancel hook
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
  // so the Playground's base-model mode works on a fresh anonymous launch
  // with no prior setup.
  app.post("/api/inference/chat", async (c) => {
    let credentials: Credentials;
    let state: { orgSlug: string; projectSlug: string };
    let credsBaseUrl: string;
    try {
      const resolved = await resolveCredentialsAndBaseUrl();
      credentials = resolved.credentials;
      credsBaseUrl = resolved.baseUrl;
      const client = new CloudApiClient({
        baseUrl: credsBaseUrl,
        credentials,
      });
      state = await ensureProjectState({ cwd: trainCwd, client, credentials });
    } catch (err) {
      // Propagate cloud-api's status verbatim (e.g. 401 / 403 / 5xx) so the
      // SPA / clients can react appropriately; collapsing everything to 400
      // would mis-report upstream outages and auth failures. Anything else
      // (local writeState failures, missing-credentials guard) is treated as
      // a server-side error.
      if (err instanceof CloudApiError) {
        return Response.json(
          { error: err.message },
          {
            status: err.status,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
    const token =
      credentials.mode === "anon" ? credentials.token : credentials.accessToken;
    const body = await c.req.text();
    const url = `${credsBaseUrl}/v1/inference/chat?orgSlug=${encodeURIComponent(state.orgSlug)}&projectSlug=${encodeURIComponent(state.projectSlug)}`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Arkor-Client": `arkor/${SDK_VERSION}`,
      },
      body,
    });
    tapDeprecation(upstream, SDK_VERSION);
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    headers.set("cache-control", "no-cache, no-transform");
    copyDeprecationHeaders(upstream.headers, headers);
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  // ---- Deployments (`*.arkor.app` URL management) -------------------------
  //
  // Studio-side routes thinly wrap the SDK's `CloudApiClient` so the SPA can
  // manage `*.arkor.app` deployments without re-implementing the cloud API
  // contract. Each request:
  //   1. Reads the project state to derive `(orgSlug, projectSlug)` scope.
  //      No scope means no deployments to list; return an empty wrapper.
  //   2. Builds a `CloudApiClient` from on-disk credentials (same flow as
  //      `/api/inference/chat`).
  //   3. Calls the corresponding SDK method.
  //   4. Maps `CloudApiError` → upstream status + message; anything else →
  //      500. This mirrors the inference/chat error envelope so the SPA has
  //      a single error-handling shape across cloud-backed routes.

  /**
   * Read project state without requiring credentials. Listing deployments
   * for a fresh workspace (no `.arkor/state.json`) is a local no-op (same
   * behaviour as `/api/jobs`), so we must NOT call `getCredentials()`
   * first: that path can throw on `autoAnonymous: false` setups or when
   * the anonymous-token bootstrap fails offline, turning the empty-list
   * read into a 500.
   */
  async function readScopeFromState(): Promise<{
    orgSlug: string;
    projectSlug: string;
  } | null> {
    const state = await readState(trainCwd);
    return state
      ? { orgSlug: state.orgSlug, projectSlug: state.projectSlug }
      : null;
  }

  /**
   * Intent of the route calling `withDeploymentClient`:
   *   - `"read"`: pure GET. If `.arkor/state.json` is missing, return
   *     404 without provisioning a remote project. Bookmarked detail
   *     pages and `/keys` lookups must NOT silently create empty cloud
   *     projects as a side effect.
   *   - `"create"`: `POST /api/deployments` only. This is the one
   *     route that can legitimately bootstrap a fresh workspace: an
   *     anonymous user clicks "New endpoint", we lazily run
   *     `ensureProjectState()`, persist `.arkor/state.json`, and
   *     forward the deployment create. Auth0 callers without state get
   *     a 400 with the manual-state remediation.
   *   - `"mutate"`: PATCH / DELETE on `:id`, key CRUD. These need an
   *     existing deployment, which by definition needs an existing
   *     scope. If `.arkor/state.json` is missing, the deployment id in
   *     the URL cannot resolve to anything in a project that doesn't
   *     exist yet, so we 404 *without bootstrapping*; provisioning a
   *     fresh project here would leave it orphaned (the PATCH /
   *     DELETE / key request would still 404 against the empty
   *     project). Adding a deployment first via the create flow is the
   *     only way these can succeed on a fresh workspace.
   */
  type ScopeIntent = "read" | "create" | "mutate";

  async function withDeploymentClient<T>(
    intent: ScopeIntent,
    handler: (args: {
      client: CloudApiClient;
      scope: { orgSlug: string; projectSlug: string };
    }) => Promise<T>,
  ): Promise<Response> {
    // Read scope from local FS first. `readScopeFromState` does not touch
    // credentials or the network, so on a fresh workspace we can answer
    // read-only routes with a clean 404 *without* tripping `getCredentials()`:
    // the latter throws when no token is on disk and `autoAnonymous` is
    // off, which would otherwise turn a documented "no deployments yet"
    // into an opaque 500.
    const scope0 = await readScopeFromState().catch(() => null);
    if (!scope0 && (intent === "read" || intent === "mutate")) {
      // Stay neutral about whether deployments exist. For anonymous
      // workspaces the first deployment-create POST will bootstrap
      // `.arkor/state.json` automatically; for Auth0 workspaces there
      // may be remote deployments that just aren't reachable until the
      // operator restores the state file by hand. Phrasing this as
      // "no deployments yet" misdiagnoses bookmarked detail / keys
      // URLs hit by an Auth0 user; the actual fix is to put
      // `.arkor/state.json` back in place.
      //
      // `"mutate"` lands here for the same reason: a PATCH / DELETE /
      // key-CRUD on a fresh workspace cannot resolve the deployment id
      // in a project that doesn't exist, and bootstrapping a brand-new
      // remote project just to 404 against it would leave the project
      // orphaned. Only `"create"` (POST /api/deployments) is allowed
      // through to the bootstrap branch below.
      //
      // `readScopeFromState` returns `null` for both "file is absent"
      // and "file exists but is unreadable / invalid JSON / missing
      // required fields" (see `readState` in `core/state.ts`). The
      // copy below covers all three so an operator with a corrupt
      // `state.json` doesn't read "missing" and assume the file is
      // already gone.
      return Response.json(
        {
          error:
            "No usable .arkor/state.json for this workspace (missing or invalid). Create your first deployment to bootstrap one (anonymous), restore the file by hand (OAuth), or regenerate it with the correct { orgSlug, projectSlug, projectId } if it's currently corrupt.",
        },
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    let credentials: Credentials;
    let client: CloudApiClient;
    let scope: { orgSlug: string; projectSlug: string } | null = scope0;
    // Capture any deprecation notice the SDK observes during this
    // request so we can re-emit it as `Deprecation` / `Warning` /
    // `Sunset` headers on the outgoing Response. Without this the
    // deployment proxy would silently swallow upstream deprecation
    // signals: `/api/jobs` and `/api/inference/chat` stream the
    // headers through verbatim, and we want browser callers to see
    // the same warnings here.
    let deprecationNotice: DeprecationNotice | null = null;

    /**
     * Build a JSON Response with the upstream deprecation headers
     * re-emitted onto it, so browser callers can surface the same
     * sunset / upgrade warnings the cloud-api raised. Mirrors the
     * passthrough that `/api/jobs` and `/api/inference/chat` get for
     * free by virtue of streaming the upstream Response straight
     * through. Hoisted to the top of the handler body so the
     * setup-side error returns below can also forward any deprecation
     * captured during `ensureProjectState()`; without this, a 4xx /
     * 5xx during bootstrap would silently drop a sunset notice the
     * cloud-api just raised.
     */
    function jsonWithDeprecation(body: unknown, status: number): Response {
      const headers = new Headers({ "content-type": "application/json" });
      if (deprecationNotice) {
        headers.set("Deprecation", "true");
        // Match the cloud-api wire shape (RFC 7234 `Warning: 299 - "…"`).
        // Sanitise the message into a valid `quoted-string`: HTTP forbids
        // CRLF / control chars in field values, and an unescaped `"` /
        // `\` would terminate or malform the header. Strip control bytes
        // (replacement keeps word boundaries readable) and backslash-
        // escape the two reserved chars per the quoted-pair rule.
        const safeMessage = deprecationNotice.message

          // Control chars are exactly what we strip; the intent is
          // to deny CR / LF / NUL / etc. from leaking into the header.
          // eslint-disable-next-line no-control-regex
          .replaceAll(/[\u0000-\u001F\u007F]/g, " ")
          .replaceAll("\\", "\\\\")
          .replaceAll('"', String.raw`\"`);
        headers.set("Warning", `299 - "${safeMessage}"`);
        if (deprecationNotice.sunset) {
          headers.set("Sunset", deprecationNotice.sunset);
        }
      }
      return Response.json(body, { status, headers });
    }
    try {
      credentials = await getCredentials();
      // Resolve the deployment client's base URL *from the credentials*
      // rather than the closure-captured `baseUrl`. The closure was
      // resolved at startup (env / production fallback only), but
      // anonymous credentials carry the URL they were issued against
      // and OAuth credentials now do too (`arkor login` writes
      // `arkorCloudApiUrl` since round 67). Without this, an operator
      // who authed against a staging / self-hosted control plane and
      // then ran `arkor dev` without re-setting `ARKOR_CLOUD_API_URL`
      // would have Studio proxy `/api/deployments/*` to production
      // and 401 on every call. `defaultArkorCloudApiUrl(credentials)`
      // still honours the env var first when set.
      const credentialsBaseUrl = defaultArkorCloudApiUrl(credentials);
      client = new CloudApiClient({
        baseUrl: credentialsBaseUrl,
        credentials,
        onDeprecation: (notice) => {
          deprecationNotice = notice;
          // Also tee the notice into the global recorder so the CLI's
          // end-of-`main()` flush still surfaces deprecation hints
          // when the same SDK is used from a non-Studio context that
          // happens to share this code path.
          recordDeprecation(notice);
        },
      });
      if (!scope) {
        // intent === "create" (read / mutate without scope returned
        // above): anonymous credentials carry an `orgSlug` and we can
        // derive a `projectSlug` from the cwd basename, so we
        // bootstrap on demand. This mirrors `/api/inference/chat` and
        // `arkor train`, which both call `ensureProjectState()` before
        // issuing their first cloud call so a user can get something
        // done from a fresh `arkor dev` without first running
        // training.
        if (credentials.mode === "anon") {
          const state = await ensureProjectState({
            cwd: trainCwd,
            client,
            credentials,
          });
          scope = {
            orgSlug: state.orgSlug,
            projectSlug: state.projectSlug,
          };
        } else {
          // Auth0 callers cannot bootstrap automatically: we don't know
          // which org / project the logged-in user wants the deployment in,
          // and neither `arkor login` nor `arkor init` populates
          // `.arkor/state.json` today (see docs/concepts/project-structure).
          // The only working path is to write the file by hand. Reuse
          // the single source-of-truth string from `core/projectState`
          // so this surface and the trainer / Playground throw exactly
          // the same instruction.
          return Response.json(
            { error: AUTH0_MISSING_STATE_MESSAGE },
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }
    } catch (err) {
      // CloudApiError from `ensureProjectState()` (the only cloud call in
      // setup) carries the upstream `{error}` body verbatim and is
      // already user-facing copy ("Slug already taken", auth issues,
      // etc.). Forward it with the original status so the SPA can show
      // an actionable message instead of a generic "Studio backend
      // unavailable" envelope. Route it through `jsonWithDeprecation`
      // so any `Deprecation` / `Warning` / `Sunset` headers the
      // bootstrap upstream emitted alongside its 4xx / 5xx still
      // surface to the SPA: `/api/jobs` and friends pass these
      // through verbatim, and we want the deployment proxy's failure
      // path to match. This mirrors the handler-side catch below.
      if (err instanceof CloudApiError) {
        return jsonWithDeprecation({ error: err.message }, err.status);
      }
      // The "no credentials on file" guard from `getCredentials()` is a
      // recoverable setup problem (the operator just needs to log in or
      // enable autoAnonymous). Surface its message verbatim with a 401
      // so the SPA can render a "Run `arkor login`" hint instead of an
      // opaque 500: `Endpoints.tsx` shows `err.message` directly in
      // its error envelopes. This text is user-facing copy from
      // `studio/server.ts`'s own throw, not user input or a filesystem
      // path, so forwarding it carries no info-leak risk.
      if (
        err instanceof Error &&
        err.message.startsWith("No credentials on file")
      ) {
        return jsonWithDeprecation({ error: err.message }, 401);
      }
      // Local-side failures (anonymous-token bootstrap, FS error) can
      // leak filesystem paths and internal endpoint hostnames in
      // `err.message` / stack. Log full detail for the operator and
      // return an opaque 500 to the SPA.
      console.error("[studio] withDeploymentClient setup failed:", err);
      return jsonWithDeprecation({ error: "Studio backend unavailable" }, 500);
    }

    try {
      const result = await handler({ client, scope });
      return jsonWithDeprecation(result, 200);
    } catch (err) {
      if (err instanceof CloudApiError) {
        // Cloud API errors are intentionally forwarded: `err.message` is
        // the structured `{ error }` body cloud-api returned, which is
        // already user-facing copy ("Slug already taken", etc.).
        return jsonWithDeprecation({ error: err.message }, err.status);
      }
      // Anything else (a thrown plain Error from the handler, an unhandled
      // network failure) is logged with full detail and returned opaque
      // to the SPA so we don't leak stack traces / filesystem paths.
      console.error("[studio] withDeploymentClient handler failed:", err);
      return jsonWithDeprecation({ error: "Studio backend error" }, 500);
    }
  }

  app.get("/api/deployments", async () => {
    // List view doesn't require credentials when there's no scope yet:
    // mirror `/api/jobs`'s local-only empty-list path so the Endpoints
    // tab loads cleanly on fresh workspaces and offline. Surface
    // `scopeMissing: true` so the SPA can distinguish "this project
    // genuinely has no deployments" from "we don't know which project
    // to look at": the latter needs different remediation copy
    // ("create your first endpoint" for anonymous; "restore
    // .arkor/state.json" for Auth0).
    const scope = await readScopeFromState();
    if (!scope) {
      return Response.json(
        { deployments: [], scopeMissing: true },
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return withDeploymentClient("read", ({ client, scope }) =>
      client.listDeployments(scope),
    );
  });

  // `c.req.json()` happily parses every well-formed JSON value,
  // including the literal `null`, so a `.catch(() => null)` would
  // collapse both "parse failed" and "valid `null` body" into the
  // same case. Use a `Symbol` sentinel; Symbols can't appear in JSON, so
  // the parse-failure branch catches *only* the syntax error and every
  // well-formed JSON value (including `null`, `false`, `0`, `""`, arrays)
  // flows through to the schema check that knows how to reject the wrong
  // shape with an accurate error message.
  const PARSE_FAILED: unique symbol = Symbol("studio.body-parse-failed");
  type ParseFailed = typeof PARSE_FAILED;
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  app.post("/api/deployments", async (c) => {
    const raw: unknown = await c.req
      .json()
      .catch((): ParseFailed => PARSE_FAILED);
    if (raw === PARSE_FAILED) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Schema-validate the body *before* entering
    // `withDeploymentClient`'s bootstrap branch. A primitive shape
    // check would let semantically invalid payloads through (e.g.
    // `{ slug: "x", authMode: "bogus", target: {} }`), and on a fresh
    // anonymous workspace `ensureProjectState()` would still run and
    // persist `.arkor/state.json` + a remote project as a side
    // effect, even though `createDeployment` would immediately 400
    // afterwards. Validating with the same schema the cloud API
    // applies (slug pattern + length, target discriminated union,
    // authMode closed enum) catches those cases here, *before*
    // anything mutates local or remote scope state.
    const parsed = createDeploymentRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: `Invalid deployment create body: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        },
        400,
      );
    }
    const body = parsed.data as Parameters<
      CloudApiClient["createDeployment"]
    >[1];
    return await withDeploymentClient(
      "create",
      async ({ client, scope }) => await client.createDeployment(scope, body),
    );
  });

  app.get("/api/deployments/:id", async (c) => {
    const id = c.req.param("id");
    return await withDeploymentClient(
      "read",
      async ({ client, scope }) => await client.getDeployment(id, scope),
    );
  });

  app.patch("/api/deployments/:id", async (c) => {
    const id = c.req.param("id");
    const raw: unknown = await c.req
      .json()
      .catch((): ParseFailed => PARSE_FAILED);
    if (raw === PARSE_FAILED) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Parse succeeded but the value isn't a settings-bag object.
    // `typeof null === "object"` is the historical JS gotcha: without
    // the explicit `!== null` here, a literal `null` body would slip
    // past the shape check and forward as `undefined`-equivalent.
    // Cloud-api would 400 these too, but reporting the shape problem
    // here keeps the "Invalid JSON" copy honest (it now means *parse
    // failed*) and gives callers a deterministic local 400 instead
    // of a round-trip-dependent one.
    if (!isPlainObject(raw)) {
      return c.json(
        { error: "Deployment update body must be a JSON object." },
        400,
      );
    }
    const body = raw as Parameters<CloudApiClient["updateDeployment"]>[2];
    return await withDeploymentClient(
      "mutate",
      async ({ client, scope }) =>
        await client.updateDeployment(id, scope, body),
    );
  });

  app.delete("/api/deployments/:id", async (c) => {
    const id = c.req.param("id");
    return await withDeploymentClient("mutate", async ({ client, scope }) => {
      await client.deleteDeployment(id, scope);
      // 204 has no body in the cloud API; the Studio API normalises this to
      // `{}` so the SPA's JSON parsing path is uniform across every route.
      return {};
    });
  });

  app.get("/api/deployments/:id/keys", async (c) => {
    const id = c.req.param("id");
    return await withDeploymentClient(
      "read",
      async ({ client, scope }) => await client.listDeploymentKeys(id, scope),
    );
  });

  app.post("/api/deployments/:id/keys", async (c) => {
    const id = c.req.param("id");
    const raw: unknown = await c.req
      .json()
      .catch((): ParseFailed => PARSE_FAILED);
    if (raw === PARSE_FAILED) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // The "must include a `label` string" copy below has to actually
    // be true: a bare object check (`typeof raw === "object"` etc.)
    // would forward `{}` and `{ label: 123 }` upstream and the
    // server-side error would be the one the SPA surfaces. Run the
    // schema validation *here* so the 400 matches the message and
    // the SDK call only fires on a well-formed body.
    const parsed = createDeploymentKeyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: `Key create body must include a non-empty \`label\` string (1-80 chars): ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        },
        400,
      );
    }
    const body = parsed.data as Parameters<
      CloudApiClient["createDeploymentKey"]
    >[2];
    return await withDeploymentClient(
      "mutate",
      async ({ client, scope }) =>
        await client.createDeploymentKey(id, scope, body),
    );
  });

  app.delete("/api/deployments/:id/keys/:keyId", async (c) => {
    const id = c.req.param("id");
    const keyId = c.req.param("keyId");
    return await withDeploymentClient("mutate", async ({ client, scope }) => {
      await client.revokeDeploymentKey(id, keyId, scope);
      return {};
    });
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

  // Resolved once so the containment check below compares against a
  // canonical absolute base even when `assetsDir` was passed relative.
  const assetsBase = resolve(assetsDir);

  async function readAsset(relPath: string): Promise<Response | null> {
    const cleaned = relPath.replace(/^\/+/, "");
    // Containment guard (CodeRabbit, round 81): `join(assetsDir, ...)`
    // is purely lexical, so any traversal sequence that survives the
    // router's normalisation (`..%2f..` variants, weird platform
    // separators) would walk OUT of the bundled assets tree and read
    // arbitrary local files. These GETs are host-guarded but NOT
    // studio-token gated (the SPA shell must load before the token
    // exists client-side), so without this check the static handler
    // is a local file-disclosure primitive. Resolve to an absolute
    // path and require it to stay under `assetsBase`. Null bytes are
    // rejected up front: they truncate paths in some libuv syscalls.
    if (cleaned.includes("\0")) return null;
    const target = resolve(assetsBase, cleaned);
    if (target !== assetsBase && !target.startsWith(`${assetsBase}${sep}`)) {
      return null;
    }
    try {
      const file = await readFile(target);
      const ext = cleaned.slice(cleaned.lastIndexOf(".") + 1);
      if (ext === "html") {
        const html = injectStudioMeta(
          file.toString("utf8"),
          studioToken,
          Boolean(options.hmr),
        );
        return new Response(html, {
          status: 200,
          headers: { "content-type": CONTENT_TYPES.html },
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
