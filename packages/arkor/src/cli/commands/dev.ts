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
import { ui } from "../prompts";

export interface DevOptions {
  port?: number;
  open?: boolean;
}

/**
 * Best-effort credential bootstrap before the Studio server starts.
 *
 *  - If credentials already exist → no-op.
 *  - Otherwise → always acquire an anonymous token. When the deployment
 *    advertises OAuth, surface a hint pointing at `arkor login` so the user
 *    can upgrade to a real session whenever they want, but don't block the
 *    Studio launch on it.
 *  - On anonymous-bootstrap network failure, warn and continue: the Studio
 *    server is built with `autoAnonymous` enabled, so it will retry on the
 *    first `/api/credentials` hit. This keeps `arkor dev` usable when the
 *    cloud-api is momentarily down.
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
    // whether the deployment offers OAuth. See the catch below for why
    // that matters for the bootstrap recovery decision.
  }

  const oauthAvailable = Boolean(
    cfg?.auth0Domain && cfg.clientId && cfg.audience,
  );
  if (oauthAvailable) {
    // Point at `--oauth` rather than the bare `arkor login`. Anyone who
    // acts on this message already implicitly accepted the anon path
    // (they ran `arkor dev` without logging in first); their only reason
    // to follow up is to upgrade to OAuth, so the interactive picker
    // would just add friction. Surface the fast path directly.
    ui.log.info(
      "No credentials on file — bootstrapping an anonymous session. Run `arkor login --oauth` to sign in to your account instead.",
    );
  } else {
    ui.log.info(
      "No credentials on file — requesting an anonymous token.",
    );
  }
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
    // Decide whether to swallow the failure or surface it. Two filters:
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
    //    Studio when we couldn't reach the cloud-api at all. If
    //    `fetchCliConfig` itself failed we don't know whether
    //    `/v1/auth/anonymous` is even enabled on this deployment, so the
    //    server-side retry on `/api/credentials` could keep failing
    //    indefinitely. Fail fast so the user sees the real cause and can
    //    re-run once connectivity is back.
    const isTransportFailure =
      err instanceof TypeError && err.message === "fetch failed";
    if (isTransportFailure && deploymentModeKnown) {
      ui.log.warn(
        `Could not reach ${baseUrl} (${err.message}). Studio will keep running and retry on first /api/credentials hit.`,
      );
      return;
    }
    // OAuth-only deployments (`/v1/auth/cli/config` advertises Auth0 but
    // `/v1/auth/anonymous` is disabled) used to be handled by delegating to
    // `runLogin()` here. The new flow always tries anon first, so a
    // permanent rejection of `/v1/auth/anonymous` would leave the user with
    // a bare "Failed to acquire anonymous token (4xx)" error and no way
    // forward. Wrap the error with an explicit pointer at `arkor login
    // --oauth` so first-run users on those deployments still have a
    // discoverable next step.
    if (!isTransportFailure && oauthAvailable) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to bootstrap an anonymous session (${cause}). This deployment may require sign-in — run \`arkor login --oauth\` and try again.`,
        { cause: err },
      );
    }
    throw err;
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
