import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createClient } from "@arkor/cloud-api-client";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
  writeCredentials,
  requestAnonymousToken,
  type Credentials,
} from "../core/credentials";
import { readState } from "../core/state";
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
   * `X-Arkor-Studio-Token`, or `?studioToken=` for `EventSource` (which can't
   * carry custom headers). The token is injected into the served `index.html`
   * as a `<meta>` tag so the same-origin SPA can read it; cross-origin tabs
   * cannot, so even a "simple" CORS POST without preflight is rejected.
   */
  studioToken: string;
  /**
   * Working directory used to resolve / validate `body.file` for `/api/train`.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
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

  if (!studioToken || studioToken.length < 16) {
    throw new Error(
      "buildStudioApp requires a studioToken with at least 16 characters of entropy.",
    );
  }

  const app = new Hono();

  // Combined defense for `/api/*`:
  //   1. Host-header guard (defense against DNS rebinding — a victim navigated
  //      to `evil.com` rebound onto 127.0.0.1 still sends `Host: evil.com`).
  //   2. Per-launch CSRF token. CORS is intentionally not configured: the SPA
  //      is same-origin so CORS adds no value, and reflecting `*` would let
  //      "simple" cross-origin POSTs (text/plain, urlencoded) skip preflight
  //      and reach the handler. The token check rejects those — an attacker
  //      page can't read the SPA's <meta> from another origin.
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      return c.json({ error: "Studio API is loopback-only" }, 403);
    }
    const provided =
      c.req.header("x-arkor-studio-token") ??
      c.req.query("studioToken") ??
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

  // ---- API routes ---------------------------------------------------------

  app.get("/api/credentials", async (c) => {
    const token = await getToken();
    const creds = await getCredentials();
    const state = await readState();
    return c.json({
      token,
      mode: creds.mode,
      baseUrl,
      orgSlug: state?.orgSlug ?? (creds.mode === "anon" ? creds.orgSlug : null),
      projectSlug: state?.projectSlug ?? null,
    });
  });

  app.get("/api/me", async (c) => {
    const rpc = createClient({ baseUrl, token: getToken });
    const res = await rpc.v1.me.$get();
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.get("/api/jobs", async (c) => {
    const state = await readState();
    if (!state) return c.json({ jobs: [] });
    const rpc = createClient({ baseUrl, token: getToken });
    const res = await rpc.v1.jobs.$get({
      query: { orgSlug: state.orgSlug, projectSlug: state.projectSlug },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.get("/api/jobs/:id/events", async (c) => {
    const id = c.req.param("id");
    const state = await readState();
    if (!state) return c.json({ error: "No project state" }, 400);
    const token = await getToken();
    const url = `${baseUrl}/v1/jobs/${encodeURIComponent(id)}/events/stream?orgSlug=${encodeURIComponent(state.orgSlug)}&projectSlug=${encodeURIComponent(state.projectSlug)}`;
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
        ...(c.req.header("Last-Event-ID")
          ? { "Last-Event-ID": c.req.header("Last-Event-ID") as string }
          : {}),
      },
    });
    const headers = new Headers();
    headers.set(
      "content-type",
      upstream.headers.get("content-type") ?? "text/event-stream",
    );
    headers.set("cache-control", "no-cache, no-transform");
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  app.post("/api/train", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { file?: string };
    let trainFile: string | undefined;
    if (body.file) {
      const baseAbs = resolve(trainCwd);
      const abs = resolve(baseAbs, body.file);
      if (abs !== baseAbs && !abs.startsWith(baseAbs + sep)) {
        return c.json(
          { error: "file must be inside the project directory" },
          400,
        );
      }
      trainFile = abs;
    }
    const args = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning"];
    const pkgBinPath = new URL("../bin.mjs", import.meta.url).pathname;
    args.push(pkgBinPath, "train");
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
  // auth path as the rest of /api/*.
  app.post("/api/inference/chat", async (c) => {
    const state = await readState();
    if (!state) return c.json({ error: "No project state" }, 400);
    const token = await getToken();
    const body = await c.req.text();
    const url = `${baseUrl}/v1/inference/chat?orgSlug=${encodeURIComponent(state.orgSlug)}&projectSlug=${encodeURIComponent(state.projectSlug)}`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
