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
  open?: boolean;
}

/**
 * Best-effort credential bootstrap before the Studio server starts.
 *
 *  - If credentials already exist → no-op.
 *  - If Auth0 is configured → run the interactive PKCE login (fatal on
 *    failure: Auth0 mode requires reaching the cloud-api to know which
 *    tenant to authorize against).
 *  - Otherwise → try to acquire an anonymous token. On network failure,
 *    warn and continue: the Studio server is built with `autoAnonymous`
 *    enabled, so it will retry on the first `/api/credentials` hit. This
 *    keeps `arkor dev` usable when the cloud-api is momentarily down.
 */
export async function ensureCredentialsForStudio(): Promise<void> {
  if (await readCredentials()) return;

  const baseUrl = defaultArkorCloudApiUrl();
  let cfg: Awaited<ReturnType<typeof fetchCliConfig>> | null = null;
  let deploymentModeKnown = false;
  try {
    cfg = await fetchCliConfig(baseUrl);
    deploymentModeKnown = true;
  } catch {
    // cfg null + deploymentModeKnown=false → we couldn't even determine
    // whether the deployment requires Auth0. See the catch below for why
    // that matters for the bootstrap recovery decision.
  }

  if (cfg?.auth0Domain && cfg.clientId && cfg.audience) {
    ui.log.info("No credentials on file — launching `arkor login`.");
    await runLogin();
    return;
  }

  ui.log.info(
    "No credentials on file and Auth0 isn't configured — requesting an anonymous token.",
  );
  try {
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
  } catch (err) {
    // Only swallow transport-level failures, AND only when we positively
    // confirmed the deployment doesn't require Auth0. Two filters:
    //
    // 1. `TypeError("fetch failed")` is undici's contract for transient
    //    transport failures (ECONNREFUSED/ETIMEDOUT/ENOTFOUND/etc.) where
    //    the cloud-api may come back. Other TypeErrors are config errors
    //    ("Invalid URL", "URL scheme must be a HTTP(S) scheme") that keep
    //    failing on every retry. Plain Errors (non-2xx responses, ZodError
    //    on garbage responses) and fs errors (EACCES on credentials.json)
    //    also keep failing on retry.
    //
    // 2. `deploymentModeKnown` guards against silently starting a broken
    //    Studio against an Auth0-only deployment. If fetchCliConfig itself
    //    failed, we don't know whether `/v1/auth/anonymous` is even
    //    enabled on this cloud-api. Server-side retry on /api/credentials
    //    would hit the same anon endpoint and get a permanent rejection
    //    instead of being routed back to the interactive `runLogin`. Fail
    //    fast so the user sees the real cause and can re-run once
    //    connectivity is back.
    const isTransportFailure =
      err instanceof TypeError && err.message === "fetch failed";
    if (!isTransportFailure || !deploymentModeKnown) {
      throw err;
    }
    ui.log.warn(
      `Could not reach ${baseUrl} (${err.message}). Studio will keep running and retry on first /api/credentials hit.`,
    );
  }
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
  // hitting `arkor start` (and therefore RCE via dynamic import).
  const studioToken = randomBytes(32).toString("base64url");

  // Persisting the token to disk is *only* needed for the Vite SPA dev
  // workflow. The bundled `:port` flow injects the meta tag at request time
  // via `buildStudioApp`, so a failure here (read-only $HOME on Docker /
  // locked-down CI / restrictive umask) must not block the server.
  try {
    const tokenPath = await persistStudioToken(studioToken);
    scheduleStudioTokenCleanup(tokenPath);
  } catch (err) {
    ui.log.warn(
      `Could not write ${studioTokenPath()} (${
        err instanceof Error ? err.message : String(err)
      }). The Studio at http://localhost:${port} is unaffected, but the Vite SPA dev workflow will see 403s on /api/*.`,
    );
  }

  // `autoAnonymous: true` (the default) lets the Hono server retry the
  // anonymous bootstrap on first `/api/credentials` hit if the up-front
  // attempt above failed (e.g. cloud-api was unreachable at launch).
  const app = buildStudioApp({ studioToken });
  // Bind to 127.0.0.1 (not "localhost") so the listener can't end up on `::1`
  // only — `@hono/node-server` passes hostname to `net.Server.listen`, which
  // calls `dns.lookup`. On hosts where `/etc/hosts` orders `::1 localhost`
  // before `127.0.0.1 localhost`, a "localhost" bind would refuse IPv4
  // connections, breaking the studio-app Vite proxy (hardcoded to
  // `http://127.0.0.1:4000`) and any browser that resolves localhost to
  // IPv4. The host-header guard already accepts both, so the displayed URL
  // can still be `localhost`.
  const url = `http://localhost:${port}`;
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  process.stdout.write(`Arkor Studio running on ${url}\n`);
  if (options.open) {
    try {
      await open(url);
    } catch {
      // fall through
    }
  }
}
