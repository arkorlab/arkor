import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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
import { createHmrCoordinator } from "../../studio/hmr";
import { buildStudioApp } from "../../studio/server";
import { ANON_PERSISTENCE_NUDGE } from "../anonymous";
import { registerCleanupHook } from "../cleanupHooks";
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
    // Point at `--oauth` rather than the bare `arkor login`. Anyone who
    // acts on this message already implicitly accepted the anon path
    // (they ran `arkor dev` without logging in first); their only reason
    // to follow up is to upgrade to OAuth, so the interactive picker
    // would just add friction. Surface the fast path directly.
    ui.log.info(
      "No credentials on file. Bootstrapping an anonymous session. Run `arkor login --oauth` to sign in to your account instead.",
    );
  } else {
    ui.log.info("No credentials on file. Requesting an anonymous token.");
  }
  // Scoped to just `requestAnonymousToken` on purpose: this is where we
  // decide whether the network failure is recoverable (transport blip vs
  // permanent rejection vs OAuth-only deployment). Local failures from
  // `writeCredentials` (EACCES/EROFS/EISDIR on `~/.arkor/credentials.json`)
  // would be miscategorised here, so they live outside this try block and
  // surface with their original fs message intact.
  let anon: Awaited<ReturnType<typeof requestAnonymousToken>>;
  try {
    anon = await requestAnonymousToken(baseUrl, "cli");
  } catch (err) {
    // Decide whether to swallow the failure or surface it. Two filters:
    //
    // 1. `TypeError("fetch failed")` is undici's contract for transient
    //    transport failures (ECONNREFUSED/ETIMEDOUT/ENOTFOUND/etc.) where
    //    the cloud-api may come back. Other TypeErrors are config errors
    //    ("Invalid URL", "URL scheme must be a HTTP(S) scheme") that keep
    //    failing on every retry. Plain Errors (non-2xx responses, ZodError
    //    on garbage responses) also keep failing on retry.
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
    //
    // Gate on `AnonymousTokenRejectedError` *and* a 4xx status so the
    // wrap fires only for genuine deployment rejection (401/403/404 et
    // al). 5xx is a transient cloud-api failure where retrying makes
    // sense, ZodErrors signal a malformed response (server bug), and fs
    // failures are out of scope for the anon endpoint entirely: none of
    // these should be mislabelled as a sign-in requirement.
    if (
      err instanceof AnonymousTokenRejectedError &&
      err.status >= 400 &&
      err.status < 500 &&
      oauthAvailable
    ) {
      // Surface only the status code at the top level: the inner
      // `err.message` already starts with "Failed to acquire…" and
      // includes the response-body snippet, which would double-prefix the
      // wrap and risk leaking noisy HTML/JSON error pages. The full
      // detail is preserved on `cause` for debugging.
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
  // see ../anonymous.ts for wording rationale and gating contract.
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
  await writeFile(path, token, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * Constant-time string comparison for the token-identity check below.
 * The "is this my token?" gate is not strictly a security-sensitive
 * comparison (both sides are owned by the user on the local FS), but
 * the SDK already uses `timingSafeEqual` for every other studio-token
 * comparison (`buildStudioApp`), and keeping the same primitive here
 * costs nothing while making the policy "tokens are always compared
 * constant-time" uniform across the codebase.
 */
function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function scheduleStudioTokenCleanup(
  path: string,
  // Token THIS process wrote. Compared against the file's current
  // contents at unlink time so we never delete a token a concurrent
  // `arkor dev` overwrote in the shared path. See cleanup body for
  // the full rationale.
  expectedToken: string,
): void {
  registerCleanupHook({
    cleanup: () => {
      // Rename-then-inspect reap (CodeRabbit, round 81). The previous
      // read → compare → unlink sequence was a TOCTOU pair: another
      // `arkor dev` could rewrite the shared `~/.arkor/studio-token`
      // BETWEEN our successful read (bytes matched ours) and our
      // unlink, so we'd delete THEIR fresh token anyway. `rename` is
      // atomic, so claiming the file first closes that window:
      //
      //   1. rename(path → private reap path). Whatever file is at
      //      `path` at the syscall instant moves; concurrent writers
      //      that land after the rename create a NEW file at `path`
      //      which we never touch.
      //   2. Inspect the claimed file. Ours (bytes match) → unlink
      //      the claimed copy; done.
      //   3. Foreign token claimed by mistake → rename it BACK to
      //      `path` to restore it. If the rename-back fails because
      //      the other process re-wrote `path` meanwhile, their
      //      newer token wins and our claimed copy (their older
      //      token) is deleted: the live file is always the newest
      //      writer's.
      //
      // The reap path carries our pid so two arkor dev processes
      // shutting down simultaneously can't collide on the temp name.
      //
      // Identity-vs-persist-flag rationale (unchanged from the prior
      // revision): a `tokenPersisted` boolean set after
      // `await persistStudioToken(...)` had its own race (signal
      // landing between writeFile completing and the flag flipping
      // would leak our token); the file's bytes are the source of
      // truth, now claimed atomically before inspection.
      const reapPath = `${path}.reap-${process.pid}`;
      try {
        renameSync(path, reapPath);
      } catch {
        // ENOENT: failed-persist run, or another shutdown already
        // cleaned up. Nothing to reap.
        return;
      }
      let claimed: string;
      try {
        claimed = readFileSync(reapPath, "utf8").trim();
      } catch {
        // Claimed file unreadable: delete the claim best-effort so we
        // don't leave a stray reap file behind.
        try {
          unlinkSync(reapPath);
        } catch {
          // best-effort
        }
        return;
      }
      if (tokensEqual(claimed, expectedToken)) {
        // Ours: the rename already removed it from the shared path;
        // just delete the claimed copy.
        try {
          unlinkSync(reapPath);
        } catch {
          // best-effort
        }
        return;
      }
      // Foreign token: restore it, UNLESS the other process already
      // re-wrote `path` after our rename claimed the old copy. Rename
      // REPLACES an existing destination rather than failing, so a
      // bare rename-back would clobber that fresher token with the
      // older claimed one. The existence probe shrinks the clobber
      // window from "read → unlink" (previous design, milliseconds
      // spanning a token comparison) to the few instructions between
      // existsSync and renameSync, and the losing outcome in that
      // residual window is restore-the-older-token (the other dev
      // server 403s until its own next rewrite), not delete-the-token
      // outright.
      try {
        if (existsSync(path)) {
          // Newest writer wins: discard the claimed older copy.
          unlinkSync(reapPath);
        } else {
          renameSync(reapPath, path);
        }
      } catch {
        try {
          unlinkSync(reapPath);
        } catch {
          // best-effort
        }
      }
    },
    // Outermost cleanup: responsible for terminating the process after
    // all earlier-registered hooks (e.g. HMR dispose) have run.
    exitOnSignal: true,
  });
}

function scheduleHmrCleanup(hmr: { dispose: () => Promise<void> }): void {
  // Registered before the studio-token cleanup so it runs first on
  // shutdown: Node fires signal handlers in registration order, and we
  // want the watcher to release file handles before the outermost
  // process.exit.
  registerCleanupHook({ cleanup: () => hmr.dispose() });
}

export async function runDev(options: DevOptions = {}): Promise<void> {
  await ensureCredentialsForStudio();

  const port = options.port ?? 4000;
  // Per-launch CSRF token: injected into index.html as <meta>, required on
  // every /api/* request. Prevents another tab on the same machine from
  // hitting `arkor start` (and therefore RCE via dynamic import).
  const studioToken = randomBytes(32).toString("base64url");

  // HMR coordinator: a long-lived rolldown watcher over the user's
  // `src/arkor` graph. The coordinator itself is lazy (`subscribe()`
  // is what starts the watcher, not `createHmrCoordinator`), but
  // `buildStudioApp` registers its per-rebuild signal-dispatch
  // subscriber unconditionally: that subscriber needs to run on
  // every BUNDLE_END regardless of whether any SSE client is
  // connected, so it can SIGUSR2/SIGTERM active `/api/train`
  // children and keep `lastSuccessConfigHash` warm for spawn-time
  // capture. Net effect: the watcher starts at server boot. An
  // `arkor dev` launched in an unbuilt project doesn't fail immediately
  // because `startWatcher` falls through to a poll loop that waits
  // for the entry file to appear (see `hmr.ts:entryWaitTimer`).
  //
  // Registered before the studio-token cleanup so the latter remains
  // the most-recently-attached signal listener (existing tests rely
  // on this ordering to find the token-removal handler).
  const hmr = createHmrCoordinator({ cwd: process.cwd() });
  scheduleHmrCleanup(hmr);

  // Register the studio-token cleanup *unconditionally* up-front. The hook
  // is the only one that calls `process.exit(0)` on SIGINT/SIGTERM/SIGHUP
  // (the HMR hook above only disposes), and `registerCleanupHook` overrides
  // Node's default "exit on signal" behaviour for any signal it listens
  // on. If we were to gate registration behind a successful
  // `persistStudioToken` and the persist threw, Ctrl-C would run the HMR
  // dispose and then leave the server idle in the foreground: no exit
  // ever fires.
  //
  // The cleanup body re-reads the file at exit time and only unlinks when
  // the bytes match `studioToken`. That single token-identity check covers:
  //   - failed persist (file never created) → readFileSync throws → no-op
  //   - successful persist that a concurrent `arkor dev` later overwrote
  //     in the same `$HOME` → tokens differ → no-op, that instance keeps
  //     working
  //   - our own token still on disk → bytes match → unlink
  // A previous design also tracked a `tokenPersisted` boolean set after
  // `await persistStudioToken(...)` resolved, but that had a race: a
  // signal arriving between `writeFile` completing and the boolean
  // flipping would skip the unlink and leave our token on disk. The
  // bytes ARE the source of truth, so the boolean was redundant.
  const tokenPath = studioTokenPath();
  scheduleStudioTokenCleanup(tokenPath, studioToken);

  // Persisting the token to disk is *only* needed for the Vite SPA dev
  // workflow. The bundled `:port` flow injects the meta tag at request time
  // via `buildStudioApp`, so a failure here (read-only $HOME on Docker /
  // locked-down CI / restrictive umask) must not block the server.
  try {
    await persistStudioToken(studioToken);
  } catch (err) {
    ui.log.warn(
      `Could not write ${tokenPath} (${
        err instanceof Error ? err.message : String(err)
      }). The Studio at http://localhost:${port} is unaffected, but the Vite SPA dev workflow will see 403s on /api/*.`,
    );
  }

  // `autoAnonymous: true` (the default) lets the Hono server retry the
  // anonymous bootstrap on first `/api/credentials` hit if the up-front
  // attempt above failed (e.g. cloud-api was unreachable at launch).
  const app = buildStudioApp({ studioToken, hmr });
  // Bind to 127.0.0.1 (not "localhost") so the listener can't end up on `::1`
  // only: `@hono/node-server` passes hostname to `net.Server.listen`, which
  // calls `dns.lookup`. On hosts where `/etc/hosts` orders `::1 localhost`
  // before `127.0.0.1 localhost`, a "localhost" bind would refuse IPv4
  // connections, breaking the studio-app Vite proxy (hardcoded to
  // `http://127.0.0.1:4000`) and any browser that resolves localhost to
  // IPv4. The host-header guard already accepts both, so the displayed URL
  // can still be `localhost`.
  const url = `http://localhost:${port}`;
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  process.stdout.write(`Arkor Studio running on ${url}\n`);
  // "ready (will watch …)" rather than "enabled (watching …)" because
  // `createHmrCoordinator` is lazy: the rolldown watcher doesn't
  // actually start until the first `subscribe()` call inside
  // `buildStudioApp`, and on a fresh scaffold with no
  // `src/arkor/index.ts` yet the watcher falls into the
  // entry-wait poll loop rather than actively watching.
  process.stdout.write(`HMR ready (will watch src/arkor)\n`);
  if (options.open) {
    try {
      await open(url);
    } catch {
      // fall through
    }
  }
}
