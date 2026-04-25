import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import open from "open";
import { fetchCliConfig } from "../../core/auth0";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
  studioTokenPath,
  writeCredentials,
  requestAnonymousToken,
  type AnonymousCredentials,
} from "../../core/credentials";
import { buildStudioApp } from "../../studio/server";
import { runLogin } from "./login";
import { ui } from "../prompts";

export interface DevOptions {
  port?: number;
  noBrowser?: boolean;
}

/**
 * Ensure we have credentials on disk before the Studio server starts.
 *
 *  - If credentials already exist → no-op.
 *  - Otherwise, ask the cloud-api whether Auth0 is configured. When it is,
 *    run the interactive PKCE login. When it isn't, fall back to anonymous.
 *
 * Doing this up-front (rather than deferring to Studio's `/api/credentials`
 * auto-anonymous) means the user gets the real Auth0 flow when available
 * instead of silently being given a throwaway identity.
 */
async function ensureCredentialsForStudio(): Promise<void> {
  if (await readCredentials()) return;

  const baseUrl = defaultArkorCloudApiUrl();
  let cfg: Awaited<ReturnType<typeof fetchCliConfig>> | null = null;
  try {
    cfg = await fetchCliConfig(baseUrl);
  } catch {
    cfg = null;
  }

  if (cfg?.auth0Domain && cfg.clientId && cfg.audience) {
    ui.log.info("No credentials on file — launching `arkor login`.");
    await runLogin();
    return;
  }

  ui.log.info(
    "No credentials on file and Auth0 isn't configured — requesting an anonymous token.",
  );
  const anon = await requestAnonymousToken(baseUrl, "cli");
  const creds: AnonymousCredentials = {
    mode: "anon",
    token: anon.token,
    anonymousId: anon.anonymousId,
    arkorCloudApiUrl: baseUrl,
    orgSlug: anon.orgSlug,
  };
  await writeCredentials(creds);
  ui.log.success(`Signed in anonymously (${anon.orgSlug}).`);
}

/**
 * Persist the per-launch token to `~/.arkor/studio-token` (mode 0600) so the
 * studio-app Vite dev server can pick it up via its `transformIndexHtml`
 * plugin. The bundled `arkor dev` flow doesn't need the file (it injects via
 * `buildStudioApp`), but the SPA dev workflow (`pnpm --filter @arkor/studio-app dev`)
 * proxies `/api/*` to :4000 and would otherwise serve a token-less index.html.
 */
async function persistStudioToken(token: string): Promise<string> {
  const path = studioTokenPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function scheduleStudioTokenCleanup(path: string): void {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      unlinkSync(path);
    } catch {
      // best-effort
    }
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}

export async function runDev(options: DevOptions = {}): Promise<void> {
  await ensureCredentialsForStudio();

  const port = options.port ?? 4000;
  // Per-launch CSRF token: injected into index.html as <meta>, required on
  // every /api/* request. Prevents another tab on the same machine from
  // hitting `arkor train` (and therefore RCE via dynamic import).
  const studioToken = randomBytes(32).toString("base64url");
  const tokenPath = await persistStudioToken(studioToken);
  scheduleStudioTokenCleanup(tokenPath);
  const app = buildStudioApp({ autoAnonymous: false, studioToken });
  const url = `http://127.0.0.1:${port}`;
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  process.stdout.write(`Arkor Studio running on ${url}\n`);
  if (!options.noBrowser) {
    try {
      await open(url);
    } catch {
      // fall through
    }
  }
}
