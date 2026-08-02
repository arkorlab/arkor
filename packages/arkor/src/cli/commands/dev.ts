import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  // Atomic write, mirroring `writeCredentials`: stage to a unique 0600 temp
  // file and rename over the shared path. A signal or crash mid-`writeFile`
  // can then never leave a TRUNCATED token at the canonical path; that would
  // be worse than no token, because the ownership-checked cleanup declines
  // to remove content it doesn't recognise, stranding a corrupt file that
  // 403s the Vite SPA workflow until the next launch rotates it. rename(2)
  // is atomic within a filesystem, so readers observe either the previous
  // complete token or this launch's complete token. The temp name carries a
  // random suffix so PID-1 collisions across containers sharing ~/.arkor
  // can't race each other's staging file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, token, { mode: 0o600 });
    try {
      // Belt-and-suspenders, same policy as `writeCredentials`: `writeFile`'s
      // create mode is already 0600 masked by umask (never wider), so a chmod
      // failure on an exotic mount must not discard a complete, staged token
      // and needlessly downgrade the Vite SPA workflow to 403s. Warn and
      // proceed to the rename.
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
    // Leave nothing behind on failure; the caller's warn path covers the rest.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
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
      //
      // Known residual windows, accepted as-is (both benign):
      //   - A signal landing mid-`writeFile` leaves a PARTIAL token
      //     at `path`. This cleanup then claims it, the byte compare
      //     fails (looks foreign), and the rename-back restores the
      //     partial file, which persists until the next `arkor dev`
      //     overwrites it. Harmless: the server that wrote it is
      //     already exiting, and a partial token authorises nothing
      //     (`tokensEqual` is length-gated + timing-safe).
      //   - The existsSync → renameSync pair in the foreign-token
      //     branch below is itself an instruction-scale TOCTOU; the
      //     losing outcome there is restore-the-older-token, never
      //     delete-the-live-token. See that branch's comment.
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

  await new Promise<void>((resolve, reject) => {
    // Tracks whether the listener has BOUND (the `listening` callback fired)
    // so the persistent 'error' listener below can tell a pre-bind failure
    // (reject) from a post-startup fault (log). The boundary is deliberately
    // the bind, not the later resolve(): an error that arrives while the
    // token is still being persisted hits an already-serving server, so
    // treating it as a startup failure would kill a healthy instance.
    let bound = false;
    // Bind FIRST, then persist the studio token and register its cleanup
    // in the `listening` callback (after a successful bind). The token
    // file (`~/.arkor/studio-token`) is a single shared path, so a second
    // `arkor dev` on the same port must fail on EADDRINUSE *without* having
    // clobbered the first instance's token or registered an exit handler
    // that would delete it. The old flow persisted up front, so a doomed
    // second launch overwrote the token and then, on its crash-exit,
    // unlinked the healthy instance's file, 403-ing the Vite SPA workflow.
    const server = serve(
      { fetch: app.fetch, port, hostname: "127.0.0.1" },
      () => {
        bound = true;
        // Cleanup hooks are registered only on SUCCESSFUL BIND: a doomed
        // second launch failing on EADDRINUSE must not leave exit/signal
        // listeners behind (the EADDRINUSE test pins the listener count),
        // and must never register a handler that could touch the healthy
        // instance's token file. HMR dispose registers FIRST so the
        // exit-owning token hook below stays outermost; if the process
        // dies before this callback runs, the un-disposed watcher is
        // reaped by process death anyway.
        scheduleHmrCleanup(hmr);
        // Register the studio-token cleanup on SUCCESSFUL BIND (main's
        // bind-first flow merged with this branch's cleanupHooks): the
        // hook is registered before (and independent of) the async token
        // persistence below, so a termination signal still routes through
        // `process.exit` with the conventional 128+signo code even when
        // persistence failed. The ordering contract with
        // `scheduleHmrCleanup` still holds inside a bound instance: the
        // token hook registers AFTER the HMR hook, so it remains the
        // outermost exit-owning hook (exitOnSignal: true awaits the HMR
        // dispose before exiting, and `process.exit` fires the
        // synchronous 'exit' event that reaps /api/train children).
        //
        // The cleanup body claims the shared file atomically (rename-then-
        // inspect reap) and only deletes bytes that match `studioToken`,
        // which keeps this registration safe in every state: token never
        // written -> nothing to claim; written by us -> claimed + removed;
        // overwritten by a concurrent instance -> foreign bytes restored,
        // newest writer wins.
        scheduleStudioTokenCleanup(studioTokenPath(), studioToken);
        // Persisting the token to disk is *only* needed for the Vite SPA
        // dev workflow. The bundled `:port` flow injects the meta tag at
        // request time via `buildStudioApp`, so a failure here (read-only
        // $HOME on Docker / locked-down CI / restrictive umask) must not
        // block the server.
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
          // "ready (will watch …)" rather than "enabled (watching …)" because
          // `createHmrCoordinator` is lazy: the rolldown watcher doesn't
          // actually start until the first `subscribe()` call inside
          // `buildStudioApp`, and on a fresh scaffold with no
          // `src/arkor/index.ts` yet the watcher falls into the
          // entry-wait poll loop rather than actively watching.
          process.stdout.write(`HMR ready (will watch src/arkor)\n`);
          resolve();
        })();
      },
    );
    server.on("error", (err: unknown) => {
      // EADDRINUSE (and friends) arrive here asynchronously. Without this
      // listener Node rethrows them as an uncaught exception, which would
      // also fire the process-wide exit handler and delete a *different*
      // healthy instance's studio-token (see the bind-first note above).
      //
      // `err` is treated as `unknown` on purpose: a non-Error emission
      // (string, null) must not crash THIS handler via a property access.
      //
      // Once bound, reject() would be a silent no-op (or, during the token-
      // persistence window, would wrongly kill an already-serving instance),
      // so log post-bind server errors instead: an operator watching a
      // running Studio should see a live socket fault (EMFILE, ...) even
      // though the process keeps serving.
      const message = err instanceof Error ? err.message : String(err);
      if (bound) {
        ui.log.warn(`Studio server error after startup: ${message}`);
        return;
      }
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      ) {
        reject(
          new Error(
            `Port ${port} is already in use. Another \`arkor dev\` may be running; pass --port to choose a different one.`,
          ),
        );
        return;
      }
      reject(err instanceof Error ? err : new Error(message));
    });
  });
  if (options.open) {
    try {
      await open(url);
    } catch {
      // fall through
    }
  }
}
