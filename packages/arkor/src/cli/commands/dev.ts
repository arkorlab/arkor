import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname } from "node:path";

import { serve } from "@hono/node-server";
import open from "open";

import { fetchCliConfig } from "../../core/auth0";
import {
  AnonymousTokenRejectedError,
  credentialsPath,
  defaultArkorCloudApiUrl,
  readCredentials,
  studioTokenPath,
  writeCredentials,
  requestAnonymousToken,
  type AnonymousCredentials,
} from "../../core/credentials";
import { buildStudioApp } from "../../studio/server";
import { ANON_PERSISTENCE_NUDGE } from "../anonymous";
import { ui } from "../prompts";

export interface DevOptions {
  port?: number;
  // True when the user typed `--port <n>` on the CLI; false/undefined when
  // the value came from commander's default ("4000"). Only affects
  // EADDRINUSE handling: an explicit port fails hard, a defaulted port
  // falls back to the next free one. Set in `main.ts` via
  // `command.getOptionValueSource("port") === "cli"`.
  portExplicit?: boolean;
  open?: boolean;
}

/**
 * Best-effort credential bootstrap before the Studio server starts.
 *
 *  - If credentials already exist → no-op.
 *  - Otherwise → always acquire an anonymous token. When the deployment
 *    advertises OAuth, surface a hint pointing at `arkor login --oauth` so
 *    the user can upgrade to a real session whenever they want, but don't
 *    block the Studio launch on it.
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
    ui.log.info(
      "No credentials on file. Bootstrapping an anonymous session. Run `arkor login --oauth` to sign in to your account instead.",
    );
  } else {
    ui.log.info("No credentials on file. Requesting an anonymous token.");
  }
  let anon: Awaited<ReturnType<typeof requestAnonymousToken>>;
  try {
    anon = await requestAnonymousToken(baseUrl, "cli");
  } catch (err) {
    const isTransportFailure =
      err instanceof TypeError && err.message === "fetch failed";
    if (isTransportFailure && deploymentModeKnown) {
      ui.log.warn(
        `Could not reach ${baseUrl} (${err.message}). Studio will keep running and retry on first /api/credentials hit.`,
      );
      return;
    }
    if (
      err instanceof AnonymousTokenRejectedError &&
      err.status >= 400 &&
      err.status < 500 &&
      oauthAvailable
    ) {
      throw new Error(
        `Failed to bootstrap an anonymous session (HTTP ${err.status}). This deployment may require sign-in. Run \`arkor login --oauth\` and try again.`,
        { cause: err },
      );
    }
    throw err;
  }

  const creds: AnonymousCredentials = {
    mode: "anon",
    token: anon.token,
    anonymousId: anon.anonymousId,
    arkorCloudApiUrl: baseUrl,
    orgSlug: anon.orgSlug,
  };
  await writeCredentials(creds);
  ui.log.info(
    `Anonymous id: ${anon.anonymousId}. Arkor Cloud uses this id to recognise this client across sessions. Keep \`${credentialsPath()}\` to stay signed in as the same anonymous identity.`,
  );
  if (oauthAvailable) {
    ui.log.warn(ANON_PERSISTENCE_NUDGE);
  }
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
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, token, { mode: 0o600 });
    try {
      await chmod(tmp, 0o600);
    } catch (err) {
      ui.log.warn(
        `Could not set permissions on ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return path;
}

/**
 * Install the process-lifetime shutdown handlers, running `cleanup` (once)
 * on normal exit and on SIGINT/SIGTERM/SIGHUP before re-exiting.
 */
function installShutdownHandlers(cleanup: () => void): void {
  let cleaned = false;
  const runCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  process.on("exit", runCleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      runCleanup();
      process.exit(128 + osConstants.signals[sig]);
    });
  }
}

// How many ports to try in total (requestedPort, +1, +2, ...) before giving
// up when the port was NOT explicitly requested. Capped so a long run of
// busy ports fails fast instead of scanning forever.
const MAX_PORT_ATTEMPTS = 10;

export async function runDev(options: DevOptions = {}): Promise<void> {
  await ensureCredentialsForStudio();

  const requestedPort = options.port ?? 4000;
  const portExplicit = options.portExplicit ?? false;
  // Per-launch CSRF token: injected into index.html as <meta>, required on
  // every /api/* request. Prevents another tab on the same machine from
  // hitting `arkor start` (and therefore RCE via dynamic import).
  const studioToken = randomBytes(32).toString("base64url");

  const app = buildStudioApp({ studioToken });

  // Filled in once the server actually binds; may differ from
  // `requestedPort` when we fell back to a free one.
  let boundPort = requestedPort;

  await new Promise<void>((resolve, reject) => {
    // Tracks whether the listener has BOUND so the persistent 'error'
    // listener can tell a pre-bind failure (reject/retry) from a
    // post-startup fault (log).
    let bound = false;

    // Attempts a bind on `port`. On EADDRINUSE, retries on `port + 1` as
    // long as the port wasn't explicit and attempts remain; otherwise
    // rejects. Bind FIRST, then persist the studio token (see original
    // comment below) so a doomed retry never clobbers a healthy
    // instance's token file.
    const attemptBind = (port: number, attemptsLeft: number) => {
      const url = `http://localhost:${port}`;
      const server = serve(
        { fetch: app.fetch, port, hostname: "127.0.0.1" },
        () => {
          bound = true;
          boundPort = port;
          installShutdownHandlers(() => {
            try {
              const path = studioTokenPath();
              if (readFileSync(path, "utf8") === studioToken) {
                unlinkSync(path);
              }
            } catch {
              // best-effort
            }
          });
          void (async () => {
            try {
              await persistStudioToken(studioToken);
            } catch (err) {
              ui.log.warn(
                `Could not write ${studioTokenPath()} (${
                  err instanceof Error ? err.message : String(err)
                }). The Studio at ${url} is unaffected, but the Vite SPA dev workflow will see 403s on /api/*.`,
              );
            }
            process.stdout.write(`Arkor Studio running on ${url}\n`);
            resolve();
          })();
        },
      );
      server.on("error", (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (bound) {
          ui.log.warn(`Studio server error after startup: ${message}`);
          return;
        }
        const isAddrInUse =
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "EADDRINUSE";
        // Only fall back to the next port when the caller didn't pin an
        // exact one and attempts remain. An explicit `--port <n>` keeps
        // today's hard-fail contract: silently landing on a different
        // port than the one the user typed would be surprising.
        if (isAddrInUse && !portExplicit && attemptsLeft > 1) {
          attemptBind(port + 1, attemptsLeft - 1);
          return;
        }
        if (isAddrInUse) {
          reject(
            new Error(
              portExplicit
                ? `Port ${port} is already in use. Another \`arkor dev\` may be running; pass --port to choose a different one.`
                : `Port ${requestedPort} is already in use, and no free port was found in ${requestedPort}-${port}. Pass --port to choose one explicitly.`,
            ),
          );
          return;
        }
        reject(err instanceof Error ? err : new Error(message));
      });
    };

    attemptBind(requestedPort, MAX_PORT_ATTEMPTS);
  });

  if (options.open) {
    try {
      await open(`http://localhost:${boundPort}`);
    } catch {
      // fall through
    }
  }
}