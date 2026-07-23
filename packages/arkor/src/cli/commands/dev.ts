import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { ExpectedCliError } from "@arkor/cli-internal";
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
  open?: boolean;
  /**
   * Agent mode (`arkor dev --agent`): run the same Studio server headlessly
   * for a coding agent. Writes a per-session JSON token file under
   * `<cwd>/.arkor/agent/` and prints its path to stdout; the browser still
   * only opens on an explicit `--open`.
   */
  agent?: boolean;
  /**
   * Project root the agent session file is written under
   * (`<cwd>/.arkor/agent/`). Defaults to `process.cwd()`. Not exposed as a
   * CLI flag; exists so tests can pin a temp project dir without `chdir`-ing
   * the vitest worker.
   */
  cwd?: string;
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
      // detail is preserved on `cause` for debugging. ExpectedCliError so
      // bin.ts prints this actionable line alone (no minified dist stack)
      // for a routine first-run-on-an-OAuth-only-deployment failure.
      throw new ExpectedCliError(
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

interface AgentSessionPayload {
  token: string;
  url: string;
  port: number;
  pid: number;
}

/** `<projectRoot>/.arkor/agent`. */
function agentDirFor(projectRoot: string): string {
  return join(projectRoot, ".arkor", "agent");
}

/**
 * Create the agent session directory. The intermediate `.arkor` is created
 * with the DEFAULT mode (matching `arkor build`'s `.arkor/build` and
 * `state.ts`), and only the `agent` leaf is tightened to 0700. A single
 * `mkdir(agentDir, { recursive: true, mode: 0o700 })` would also apply 0700
 * to a freshly-created `.arkor`, diverging from every other creator and
 * breaking cross-uid traversal of `.arkor/build` when agent mode happens to
 * be the first command to create `.arkor`.
 */
async function ensureAgentDir(projectRoot: string): Promise<string> {
  const dir = agentDirFor(projectRoot);
  await mkdir(join(projectRoot, ".arkor"), { recursive: true });
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o700);
  } catch (err) {
    ui.log.warn(
      `Could not set permissions on ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return dir;
}

/**
 * Atomically write the agent-mode session file to `path` (a pre-computed,
 * per-launch-unique `session-<pid>-<uuid>.json`, mode 0600). The caller owns
 * `path` up front (see `runDev`) so the shutdown handler can unlink exactly
 * this path even if a signal lands mid-write; that is why the temp name is
 * the deterministic `${path}.tmp` rather than a uuid sibling (the path itself
 * already carries a unique uuid, so no cross-launch collision is possible).
 */
async function writeAgentSessionFile(
  path: string,
  payload: AgentSessionPayload,
): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      // Same belt-and-suspenders policy as `persistStudioToken`.
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
}

/**
 * True when the busy `port` is held by a running Arkor Studio that serves
 * THIS project. Used by the normal-mode EADDRINUSE path so a plain
 * `arkor dev` connects to an already-running Studio (typically an
 * `arkor dev --agent` session that owns the port) instead of failing.
 *
 * The probe hits the token-EXEMPT `GET /api/status` over `127.0.0.1` (not
 * `localhost`, matching the server's IPv4 bind and avoiding the `::1`-first
 * resolution the module goes out of its way to dodge). No token is sent: the
 * endpoint is secrets-free, so we never disclose the CSRF token to an
 * unverified port occupant. Adoption requires both the `server:
 * "arkor-studio"` discriminator AND that the instance's `cwd` (realpath)
 * equals this launch's project root, so a plain `arkor dev` in project B
 * never silently attaches to project A's Studio on the same default port.
 * Best-effort: any failure (timeout, non-Studio occupant, different project,
 * unreadable cwd) reports false and the caller falls back to the existing
 * port-in-use error.
 */
async function probeExistingStudio(
  port: number,
  projectRoot: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      new URL("/api/status", `http://127.0.0.1:${port}`),
      { signal: AbortSignal.timeout(1500) },
    );
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return false;
    const b = body as { server?: unknown; cwd?: unknown };
    if (b.server !== "arkor-studio") return false;
    // Require an ABSOLUTE cwd: a real Studio always reports its resolved
    // project root (`trainCwd`, itself absolute). Rejecting a relative value
    // stops a hostile occupant from returning `cwd: "."`, which
    // `realpathSync` would otherwise resolve against THIS process's cwd
    // (= projectRoot) and so spuriously pass the same-project check.
    if (typeof b.cwd !== "string" || !isAbsolute(b.cwd)) return false;
    // Compare realpaths so a symlinked project root (e.g. macOS
    // `/var` -> `/private/var`) still matches the same project.
    return realpathSync(b.cwd) === realpathSync(projectRoot);
  } catch {
    return false;
  }
}

/**
 * Install the process-lifetime shutdown handlers, running `cleanup` (once)
 * on normal exit and on SIGINT/SIGTERM/SIGHUP before re-exiting.
 *
 * Registered unconditionally once the server binds, NOT gated on studio-token
 * persistence: even when persistence failed (read-only `$HOME` on Docker),
 * a termination signal must still route through `process.exit` so that (a) it
 * reports the conventional `128 + signal` code and (b) the synchronous 'exit'
 * event fires, which is what lets each `/api/train` child register its own
 * kill hook (see studio/server.ts) and avoid being orphaned on `docker stop`.
 * `cleanup` itself handles the token file (a no-op when none was written).
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
      // Exit with the conventional `128 + signal number` code (SIGINT ->
      // 130, SIGTERM -> 143, SIGHUP -> 129) rather than 0, so a supervisor
      // (systemd, `docker stop`, a shell `$?`) can tell the process was
      // terminated by a signal instead of exiting cleanly. `process.exit`
      // fires the 'exit' listener above synchronously.
      process.exit(128 + osConstants.signals[sig]);
    });
  }
}

export interface RunDevResult {
  /**
   * True when this launch found a healthy Studio already serving the project
   * on the requested port and connected to it (printed "already running" and
   * will exit) instead of starting its own server. False when this process
   * bound the port and is now serving. Lets the telemetry wrapper emit a
   * `cli_command_completed` for the short-lived connect outcome while still
   * treating the serving outcome as long-running.
   */
  adopted: boolean;
}

export async function runDev(options: DevOptions = {}): Promise<RunDevResult> {
  await ensureCredentialsForStudio();

  const port = options.port ?? 4000;
  const agent = options.agent === true;
  const projectRoot = options.cwd ?? process.cwd();
  const agentDir = agentDirFor(projectRoot);
  // Compute the session-file path UP FRONT (per-launch-unique via uuid) so the
  // shutdown handler can unlink exactly this path even if a signal lands
  // mid-write, and so cleanup never has to sweep the dir by pid prefix (which
  // would delete a co-located live session sharing this pid, e.g. two
  // containers bind-mounting the same project both running as pid 1).
  const agentSessionPath = agent
    ? join(agentDir, `session-${process.pid}-${randomUUID()}.json`)
    : undefined;
  // Set true only on the normal-mode "connect to a running Studio" path.
  let adopted = false;
  // Per-launch CSRF token: injected into index.html as <meta>, required on
  // every /api/* request. Prevents another tab on the same machine from
  // hitting `arkor start` (and therefore RCE via dynamic import).
  const studioToken = randomBytes(32).toString("base64url");

  // Bind to 127.0.0.1 (not "localhost") so the listener can't end up on `::1`
  // only: `@hono/node-server` passes hostname to `net.Server.listen`, which
  // calls `dns.lookup`. On hosts where `/etc/hosts` orders `::1 localhost`
  // before `127.0.0.1 localhost`, a "localhost" bind would refuse IPv4
  // connections, breaking the studio-app Vite proxy (hardcoded to
  // `http://127.0.0.1:4000`) and any browser that resolves localhost to
  // IPv4. The host-header guard accepts both.
  //
  // Two URL forms: `url` (localhost) is human-facing (the stdout line, the
  // browser `--open` target: browsers do Happy-Eyeballs and a friendly host
  // reads better). `agentUrl` (127.0.0.1) is what a coding AGENT consumes
  // programmatically (the session file's `url`, the `/api/status` echo): an
  // agent's HTTP client may not do Happy-Eyeballs, so it must get the same
  // IPv4 literal the server actually bound, not a name that can resolve to
  // an unbound `::1`.
  const url = `http://localhost:${port}`;
  const agentUrl = `http://127.0.0.1:${port}`;

  // `autoAnonymous: true` (the default) lets the Hono server retry the
  // anonymous bootstrap on first `/api/credentials` hit if the up-front
  // attempt above failed (e.g. cloud-api was unreachable at launch).
  // `cwd` keeps the server's project root (/api/train file resolution,
  // /api/status `cwd`) aligned with where the agent session file lands
  // when tests pin `options.cwd`; in production both default to
  // `process.cwd()` either way.
  const app = buildStudioApp({
    studioToken,
    mode: agent ? "agent" : "studio",
    // Echo the agent-facing (127.0.0.1) URL from /api/status so a probe or
    // agent reading it reaches the bound listener regardless of localhost
    // resolution order.
    url: agentUrl,
    cwd: projectRoot,
  });

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
        // Install shutdown handlers immediately on successful bind, BEFORE
        // (and independent of) token persistence. The handlers must fire even
        // when persistence fails so a termination signal still reaps any
        // /api/train child and reports the right exit code. The cleanup
        // resolves the token path directly (rather than gating on a variable
        // assigned after persistence resolves): a signal landing after the
        // atomic rename placed the token but before persistStudioToken's
        // continuation ran would otherwise leave the file behind (a signal
        // before the rename abandons only the disposable .tmp staging file,
        // never the canonical path). The ownership check
        // below makes the direct resolution safe in every state: not yet
        // written -> ENOENT (caught); written by us -> matches, removed;
        // overwritten by another instance -> differs, left alone.
        installShutdownHandlers(() => {
          try {
            // Ownership check before unlinking: the token path is a single
            // shared file, so a second `arkor dev` on a DIFFERENT port may
            // have legitimately overwritten it since we wrote it
            // (last-writer-wins is the documented multi-instance
            // behaviour). Deleting it then would 403 the OTHER, still-
            // running instance's Vite SPA workflow; only remove the file
            // if it still holds OUR token.
            const path = studioTokenPath();
            if (readFileSync(path, "utf8") === studioToken) {
              unlinkSync(path);
            }
          } catch {
            // best-effort
          }
          // Remove exactly this launch's session file (and its deterministic
          // `.tmp` staging sibling, in case a signal landed mid-write). The
          // path is per-launch-unique and known up front, so no pid-prefix
          // sweep is needed: sweeping would delete a co-located LIVE session
          // that happens to share this pid (two containers bind-mounting the
          // same project, both pid 1). ENOENT (never written / already gone)
          // is swallowed.
          if (agentSessionPath !== undefined) {
            for (const p of [agentSessionPath, `${agentSessionPath}.tmp`]) {
              try {
                unlinkSync(p);
              } catch {
                // best-effort
              }
            }
          }
        });
        void (async () => {
          if (agent && agentSessionPath !== undefined) {
            // The session file is the agent's only realistic token channel
            // (an agent does not scrape the <meta> tag the SPA reads), so
            // unlike the home token below a write failure aborts startup
            // instead of degrading: a warn-and-continue server would be
            // silently unusable to its own caller.
            try {
              await ensureAgentDir(projectRoot);
              // We deliberately do NOT sweep other session files here. A
              // crashed prior session leaves an inert `session-*.json`
              // (its token died with the server); the documented recipe
              // picks the NEWEST file (`ls -t`), which is always this live
              // launch's, so a stale file is never selected. A pid-liveness
              // sweep (`process.kill(pid, 0)`) would be actively unsafe when
              // the project dir is a shared bind-mount across containers:
              // pids are namespace-local, so a live foreign session's file
              // would look dead (ESRCH) and get deleted out from under it.
              await writeAgentSessionFile(agentSessionPath, {
                token: studioToken,
                // Agent-facing URL: 127.0.0.1 (the literal the server bound),
                // never `localhost`, so a non-Happy-Eyeballs client reaches it.
                url: agentUrl,
                port,
                pid: process.pid,
              });
            } catch (err) {
              try {
                server.close();
              } catch {
                // best-effort
              }
              // Reject with an ExpectedCliError so bin.ts prints this
              // actionable line ALONE (no minified stack). The previous flow
              // logged the message via ui.log.error AND rejected with the raw
              // fs Error, so bin.ts also dumped a code-frame: a routine
              // read-only-`.arkor` failure printed twice, once as noise.
              reject(
                new ExpectedCliError(
                  `Could not write the agent session file under ${agentDir} (${
                    err instanceof Error ? err.message : String(err)
                  }). Agent mode requires it; aborting.`,
                ),
              );
              return;
            }
          }
          // Persisting the token to `~/.arkor/studio-token` is needed for
          // the Vite SPA dev workflow and the port-collision probe. The
          // bundled `:port` flow injects the meta tag at request time via
          // `buildStudioApp`, so a failure here (read-only $HOME on Docker
          // / locked-down CI / restrictive umask) must not block the
          // server.
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
          if (agentSessionPath !== undefined) {
            // Stable, greppable contract for coding agents (documented in
            // docs/cli/dev.mdx): the path line prefix must not change.
            process.stdout.write(
              `Arkor Studio agent session file: ${agentSessionPath}\n`,
            );
            process.stdout.write(
              "Read the token from that file and send it as the X-Arkor-Studio-Token header on /api/* requests.\n",
            );
          }
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
        // ExpectedCliError (not a bare Error) so bin.ts prints this one
        // actionable line and exits 1 WITHOUT a minified `dist/bin.mjs`
        // code-frame; a busy port is the most common dev failure and the
        // stack would be pure noise. Mirrors the agent-write hard-fail below.
        const portInUse = new ExpectedCliError(
          `Port ${port} is already in use. Another \`arkor dev\` may be running; pass --port to choose a different one.`,
        );
        if (agent) {
          // An agent session needs its own server process and session-file
          // lifecycle, so never adopt an existing instance; ask for --port.
          reject(portInUse);
          return;
        }
        // Normal mode: the occupant may be a healthy Studio, typically an
        // `arkor dev --agent` session that owns the port. Probe the token-
        // exempt /api/status over 127.0.0.1 (no token disclosed) and adopt it
        // only when it is an Arkor Studio serving THIS project; then "connect":
        // print the URL and resolve so the caller can honor --open against the
        // existing instance and exit 0. Bind-first ordering guarantees this
        // launch wrote no files and registered no shutdown handlers, so
        // resolving here cannot disturb the running instance.
        void (async () => {
          const ok = await probeExistingStudio(port, projectRoot);
          if (ok) {
            try {
              server.close();
            } catch {
              // best-effort
            }
            adopted = true;
            process.stdout.write(`Arkor Studio already running on ${url}\n`);
            resolve();
            return;
          }
          reject(portInUse);
        })();
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

  return { adopted };
}
