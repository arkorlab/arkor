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
import {
  AUTH0_MISSING_STATE_MESSAGE,
  ensureProjectState,
} from "../core/projectState";
import {
  createDeploymentKeyRequestSchema,
  createDeploymentRequestSchema,
} from "../core/schemas";
import { readState } from "../core/state";
import { readManifestSummary } from "./manifest";

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
  const jobEventsPathPattern = /^\/api\/jobs\/[^/]+\/events$/;

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
      c.req.method === "GET" && jobEventsPathPattern.test(c.req.path);
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

  function tokenFromCredentials(c: Credentials): string {
    return c.mode === "anon" ? c.token : c.accessToken;
  }

  /**
   * Load credentials and resolve the cloud API base URL from them.
   * `defaultArkorCloudApiUrl(credentials)` picks `ARKOR_CLOUD_API_URL`
   * env first, then the URL stamped onto the credentials at signup
   * (anonymous) or login (OAuth, since round 67), then production.
   * This is the supported way for every Studio route to follow the
   * control plane the credentials came from — the closure-captured
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

  app.get("/api/me", async (c) => {
    const { token, baseUrl: credsBaseUrl } =
      await resolveCredentialsAndBaseUrl();
    const rpc = createRpc(credsBaseUrl, token);
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
    const args = [trainBinPath, "start"];
    if (trainFile) args.push(trainFile);
    const child = spawn(process.execPath, args, {
      stdio: "pipe",
      cwd: trainCwd,
    });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        child.stdout.on("data", (d) => controller.enqueue(enc.encode(d)));
        child.stderr.on("data", (d) => controller.enqueue(enc.encode(d)));
        child.on("close", (code) => {
          controller.enqueue(enc.encode(`\n---\nexit=${code}\n`));
          controller.close();
        });
      },
      cancel() {
        child.kill();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });

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
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    headers.set("cache-control", "no-cache, no-transform");
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  // ---- Deployments (`*.arkor.app` URL management) -------------------------
  //
  // Studio-side routes thinly wrap the SDK's `CloudApiClient` so the SPA can
  // manage `*.arkor.app` deployments without re-implementing the cloud API
  // contract. Each request:
  //   1. Reads the project state to derive `(orgSlug, projectSlug)` scope —
  //      no scope means no deployments to list, return an empty wrapper.
  //   2. Builds a `CloudApiClient` from on-disk credentials (same flow as
  //      `/api/inference/chat`).
  //   3. Calls the corresponding SDK method.
  //   4. Maps `CloudApiError` → upstream status + message; anything else →
  //      500. This mirrors the inference/chat error envelope so the SPA has
  //      a single error-handling shape across cloud-backed routes.

  /**
   * Read project state without requiring credentials. Listing deployments
   * for a fresh workspace (no `.arkor/state.json`) is a local no-op — same
   * behaviour as `/api/jobs` — so we must NOT call `getCredentials()`
   * first: that path can throw on `autoAnonymous: false` setups or when
   * the anonymous-token bootstrap fails offline, turning the empty-list
   * read into a 500.
   */
  async function readScopeFromState(): Promise<
    { orgSlug: string; projectSlug: string } | null
  > {
    const state = await readState(trainCwd);
    return state
      ? { orgSlug: state.orgSlug, projectSlug: state.projectSlug }
      : null;
  }

  /**
   * Intent of the route calling `withDeploymentClient`:
   *   - `"read"` — pure GET. If `.arkor/state.json` is missing, return
   *     404 without provisioning a remote project. Bookmarked detail
   *     pages and `/keys` lookups must NOT silently create empty cloud
   *     projects as a side effect.
   *   - `"create"` — `POST /api/deployments` only. This is the one
   *     route that can legitimately bootstrap a fresh workspace: an
   *     anonymous user clicks "New endpoint", we lazily run
   *     `ensureProjectState()`, persist `.arkor/state.json`, and
   *     forward the deployment create. Auth0 callers without state get
   *     a 400 with the manual-state remediation.
   *   - `"mutate"` — PATCH / DELETE on `:id`, key CRUD. These need an
   *     existing deployment, which by definition needs an existing
   *     scope. If `.arkor/state.json` is missing, the deployment id in
   *     the URL cannot resolve to anything in a project that doesn't
   *     exist yet, so we 404 *without bootstrapping* — provisioning a
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
    // read-only routes with a clean 404 *without* tripping `getCredentials()`
    // — the latter throws when no token is on disk and `autoAnonymous` is
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
      // URLs hit by an Auth0 user — the actual fix is to put
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
      return new Response(
        JSON.stringify({
          error:
            "No usable .arkor/state.json for this workspace (missing or invalid). Create your first deployment to bootstrap one (anonymous), restore the file by hand (OAuth), or regenerate it with the correct { orgSlug, projectSlug, projectId } if it's currently corrupt.",
        }),
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
    // signals — `/api/jobs` and `/api/inference/chat` stream the
    // headers through verbatim, and we want browser callers to see
    // the same warnings here.
    let deprecationNotice: import("../core/deprecation").DeprecationNotice | null = null;

    /**
     * Build a JSON Response with the upstream deprecation headers
     * re-emitted onto it, so browser callers can surface the same
     * sunset / upgrade warnings the cloud-api raised. Mirrors the
     * passthrough that `/api/jobs` and `/api/inference/chat` get for
     * free by virtue of streaming the upstream Response straight
     * through. Hoisted to the top of the handler body so the
     * setup-side error returns below can also forward any deprecation
     * captured during `ensureProjectState()` — without this, a 4xx /
     * 5xx during bootstrap would silently drop a sunset notice the
     * cloud-api just raised.
     */
    function jsonWithDeprecation(body: unknown, status: number): Response {
      const headers = new Headers({ "content-type": "application/json" });
      if (deprecationNotice) {
        headers.set("Deprecation", "true");
        // Match the cloud-api wire shape (RFC 7234 `Warning: 299 - "…"`).
        headers.set("Warning", `299 - "${deprecationNotice.message}"`);
        if (deprecationNotice.sunset) {
          headers.set("Sunset", deprecationNotice.sunset);
        }
      }
      return new Response(JSON.stringify(body), { status, headers });
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
          // Auth0 callers cannot bootstrap automatically — we don't know
          // which org / project the logged-in user wants the deployment in,
          // and neither `arkor login` nor `arkor init` populates
          // `.arkor/state.json` today (see docs/concepts/project-structure).
          // The only working path is to write the file by hand. Reuse
          // the single source-of-truth string from `core/projectState`
          // so this surface and the trainer / Playground throw exactly
          // the same instruction.
          return new Response(
            JSON.stringify({ error: AUTH0_MISSING_STATE_MESSAGE }),
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
      // surface to the SPA — `/api/jobs` and friends pass these
      // through verbatim, and we want the deployment proxy's failure
      // path to match. This mirrors the handler-side catch below.
      if (err instanceof CloudApiError) {
        return jsonWithDeprecation({ error: err.message }, err.status);
      }
      // The "no credentials on file" guard from `getCredentials()` is a
      // recoverable setup problem (the operator just needs to log in or
      // enable autoAnonymous). Surface its message verbatim with a 401
      // so the SPA can render a "Run `arkor login`" hint instead of an
      // opaque 500 — `Endpoints.tsx` shows `err.message` directly in
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
      return jsonWithDeprecation(
        { error: "Studio backend unavailable" },
        500,
      );
    }

    try {
      const result = await handler({ client, scope });
      return jsonWithDeprecation(result, 200);
    } catch (err) {
      if (err instanceof CloudApiError) {
        // Cloud API errors are intentionally forwarded — `err.message` is
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
    // List view doesn't require credentials when there's no scope yet —
    // mirror `/api/jobs`'s local-only empty-list path so the Endpoints
    // tab loads cleanly on fresh workspaces and offline. Surface
    // `scopeMissing: true` so the SPA can distinguish "this project
    // genuinely has no deployments" from "we don't know which project
    // to look at" — the latter needs different remediation copy
    // ("create your first endpoint" for anonymous; "restore
    // .arkor/state.json" for Auth0).
    const scope = await readScopeFromState();
    if (!scope) {
      return new Response(
        JSON.stringify({ deployments: [], scopeMissing: true }),
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
  // same case. Use a `Symbol` sentinel — Symbols can't appear in JSON
  // — so the parse-failure branch catches *only* the syntax error and
  // every well-formed JSON value (including `null`, `false`, `0`,
  // `""`, arrays) flows through to the schema check that knows how
  // to reject the wrong shape with an accurate error message.
  const PARSE_FAILED: unique symbol = Symbol("studio.body-parse-failed");
  type ParseFailed = typeof PARSE_FAILED;
  const isPlainObject = (
    value: unknown,
  ): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  app.post("/api/deployments", async (c) => {
    const raw = await c.req
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
    // effect — even though `createDeployment` would immediately 400
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
    const body = parsed.data as Parameters<CloudApiClient["createDeployment"]>[1];
    return await withDeploymentClient("create", async ({ client, scope }) =>
      await client.createDeployment(scope, body),
    );
  });

  app.get("/api/deployments/:id", async (c) => {
    const id = c.req.param("id");
    return await withDeploymentClient("read", async ({ client, scope }) =>
      await client.getDeployment(id, scope),
    );
  });

  app.patch("/api/deployments/:id", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req
      .json()
      .catch((): ParseFailed => PARSE_FAILED);
    if (raw === PARSE_FAILED) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Parse succeeded but the value isn't a settings-bag object.
    // `typeof null === "object"` is the historical JS gotcha — without
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
    return await withDeploymentClient("mutate", async ({ client, scope }) =>
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
    return await withDeploymentClient("read", async ({ client, scope }) =>
      await client.listDeploymentKeys(id, scope),
    );
  });

  app.post("/api/deployments/:id/keys", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req
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
    return await withDeploymentClient("mutate", async ({ client, scope }) =>
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
