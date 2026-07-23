import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

import { ARKOR_BIN } from "./bins";
import { getEphemeralPort } from "./ports";

export interface StartStudioOptions {
  /** Test-scoped HOME so `~/.arkor/credentials.json` is the seeded one. */
  home: string;
  /** Project root (cwd) so `arkor dev` reads the seeded manifest + state. */
  projectDir: string;
  /** Fake cloud-api base URL (`http://127.0.0.1:<port>`). */
  cloudApiUrl: string;
  /** Spawn with `--agent` (agent mode: session file under `.arkor/agent/`). */
  agent?: boolean;
}

export interface StudioHandle {
  /** `http://127.0.0.1:<port>`: the live Studio. */
  url: string;
  /** Per-launch CSRF token, parsed out of the served `index.html`. */
  token: string;
  /**
   * Absolute path of the agent session file, parsed from the stdout
   * contract line (`Arkor Studio agent session file: <path>`). Only set
   * when the studio was started with `agent: true`.
   */
  sessionFile?: string;
  /** Send SIGINT and await child exit. Idempotent. */
  kill: () => Promise<void>;
}

const READY_LINE_PATTERN = /Arkor Studio running on/;
// Agent mode's stable stdout contract (documented in docs/cli/dev.mdx). In
// agent mode readiness waits for THIS line instead: it is written by the
// same async block right after the ready line, so matching it both proves
// the server is up and hands us the session-file path without a second
// wait-and-parse pass racing the child's stdout flush.
const AGENT_SESSION_LINE_PATTERN = /^Arkor Studio agent session file: (.+)$/m;
const READY_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 50;
const PORT_POLL_TIMEOUT_MS = 10_000;
/**
 * Cap on the rolling stdio buffers below. ~4 KiB is well above the
 * ready line (~50 bytes) and the 2000-char error tail we surface on
 * failure, while preventing the buffer from growing unboundedly under
 * `STUDIO_E2E_DEBUG` runs (where the child can emit lots of output).
 */
const STDIO_BUFFER_CAP = 4096;

/**
 * Rolling string buffer with a bounded memory footprint. Memory is
 * capped at ~`2 * cap` bytes: every time `append` lifts the buffer
 * past `2 * cap` it slices back to the most-recent `cap`, so
 * `toString()` may return up to ~`2 * cap` bytes. Total append work
 * is linear in the bytes written (the lazy truncation amortises the
 * O(cap) slice across `cap` worth of appends). Used in place of an
 * unbounded `string[]` so the ready-line detector (which runs on
 * every stdout chunk) avoids the O(n²) cost of `Array.join("")`
 * over a growing chunk list.
 */
class TailBuffer {
  private buf = "";
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  append(chunk: string): void {
    this.buf += chunk;
    // Truncate lazily once we cross 2× the cap so the slice is
    // amortised O(cap) per append, not O(buf.length).
    if (this.buf.length > this.cap * 2) {
      this.buf = this.buf.slice(-this.cap);
    }
  }
  toString(): string {
    return this.buf;
  }
  tail(n: number): string {
    return this.buf.slice(-n);
  }
}

/**
 * `arkor dev`'s [@hono/node-server] writes the "Arkor Studio running on …"
 * line *before* the underlying `http.Server.listen()` settles, so a fetch
 * fired in the small window between stdout flush and bound socket gets
 * `ECONNREFUSED`. The window is sub-millisecond on a warm Node process but
 * grows on a cold one. Poll a bare TCP connect until the kernel accepts:
 * cheaper than retrying every test's fetch and keeps the contract local
 * to the harness so spec authors can fetch immediately after `studio.url`.
 */
async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + PORT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host: "127.0.0.1", port });
      // `sock.unref()` keeps a hanging connect attempt from holding the
      // event loop open if the test caller decides to bail out before
      // we resolve.
      sock.unref();
      sock.once("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => {
        // `destroy()` releases the underlying TCP handle immediately;
        // without it a stream of refused-connect retries can pile up
        // half-open sockets in the parent process and complicate
        // debugging when a real connection problem follows.
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Port ${String(port)} did not become ready within ${String(PORT_POLL_TIMEOUT_MS)}ms`,
  );
}

/**
 * Build an idempotent killer that sends SIGINT (mirrors Ctrl-C, lets
 * `dev.ts` signal handlers clean up `~/.arkor/studio-token`) and falls
 * back to SIGKILL after 5s. Used by both the returned `StudioHandle`
 * and the startup error path so a failed `waitForPort` /
 * `readMetaToken` can't leave an orphaned `arkor dev` running.
 */
function makeKill(child: ChildProcess): () => Promise<void> {
  let killed = false;
  // Track `close` from the moment `makeKill` is constructed so a
  // late `kill()` call (e.g. teardown invoked after a spawn error)
  // doesn't attach a fresh listener for an event that's already
  // fired and never returns. `close` is universal: it follows
  // `exit` for normal terminations and `error` for spawn failures,
  // and always fires exactly once per child.
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  return async () => {
    if (killed) return;
    killed = true;
    await new Promise<void>((resolve) => {
      // Pre-declared with `undefined` rather than `null` so
      // `clearTimeout(fallback)` is always type-correct (Node's
      // `clearTimeout` accepts `undefined` as a no-op); no null
      // guard needed in `onClose` below. The closure captures
      // `fallback` before the assignment on line 168, so `const`
      // wouldn't work here.
      // eslint-disable-next-line prefer-const
      let fallback: ReturnType<typeof setTimeout> | undefined;
      // Wait on `close`, not `exit`: Node skips `exit` when the
      // process fails to spawn (it emits `error` then `close`) and
      // some failure paths skip `exit` while still emitting `close`.
      // `close` always fires after stdio is fully drained, once for
      // every spawn outcome (success, error, signal-killed), so it
      // is the only universally reliable teardown signal.
      const onClose = () => {
        clearTimeout(fallback);
        resolve();
      };
      child.once("close", onClose);
      // Race-free closed check: the listener is attached *before*
      // we read the flag. If `close` already fired (`closed === true`,
      // set by the constructor-time tracker above), our listener
      // can't re-fire: detach it and resolve immediately. If
      // `close` hasn't fired yet, the listener is in place and will
      // catch the event whenever it does. Checking the flag *after*
      // the attach (instead of returning early before `new Promise`)
      // closes the theoretical "fired between check and attach"
      // window.
      if (closed) {
        child.off("close", onClose);
        resolve();
        return;
      }
      // `child.killed` flips true the moment Node *delivers* a
      // signal, not when the child actually exits. Probe the real
      // termination state via `exitCode` / `signalCode`; both stay
      // null until the child reports `exit` (and stay null forever
      // for spawn failures), so this guard fires SIGKILL only when
      // we're genuinely still waiting on a live process.
      fallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
      child.kill("SIGINT");
    });
  };
}

interface SpawnedStudio {
  child: ChildProcess;
  url: string;
  /** Idempotent teardown for `child`, exposed so `startStudio` reuses
   *  the same instance instead of allocating a second wrapper around
   *  the same process. */
  kill: () => Promise<void>;
  stderr: TailBuffer;
  stdout: TailBuffer;
  /** Agent-mode session file path (see `StudioHandle.sessionFile`). */
  sessionFile?: string;
}

/**
 * Build the child env for a spawned `arkor dev`, shared by `spawnStudio`
 * (long-running) and `spawnDevToExit` (run-to-exit). Strips the parent's
 * `npm_config_*`/`pnpm_config_*` (keep the child's pm detection hermetic) and
 * `CLAUDECODE` (case-insensitively: `arkor dev` refuses to start under
 * `CLAUDECODE=1` without `--agent`, so an inherited value from a Claude Code
 * session must not leak into the child and flip the gate; same policy as
 * `e2e/cli/src/spawn-cli.ts`), then layers the hermetic-E2E overrides.
 */
function studioChildEnv(opts: StartStudioOptions): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const lower = k.toLowerCase();
    if (
      lower.startsWith("npm_config_") ||
      lower.startsWith("pnpm_config_") ||
      lower === "claudecode"
    ) {
      continue;
    }
    cleanEnv[k] = v;
  }
  return {
    ...cleanEnv,
    CI: "1",
    HOME: opts.home,
    // Mirror HOME onto USERPROFILE so the spawned CLI's `os.homedir()`
    // resolves to the test temp dir on Windows too (see the matching
    // comment in e2e/cli/src/spawn-cli.ts).
    USERPROFILE: opts.home,
    ARKOR_CLOUD_API_URL: opts.cloudApiUrl,
    // Defence in depth: if anything anonymous-bootstrapped slips through
    // credential pre-seeding, telemetry posts must not hit the real PostHog
    // endpoint from CI.
    ARKOR_TELEMETRY_DISABLED: "1",
    npm_config_user_agent: "",
  };
}

/**
 * Spawn `arkor dev` with the shared hermetic env and the given extra args,
 * and resolve once the child exits. For run-to-exit flows (e.g. a plain
 * `arkor dev` on a busy port that connects to a running Studio and exits 0),
 * which `startStudio` cannot model because it waits for a ready line and
 * returns a live handle.
 */
export function spawnDevToExit(
  opts: StartStudioOptions,
  extraArgs: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ARKOR_BIN, "dev", ...extraArgs], {
      cwd: opts.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: studioChildEnv(opts),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    // Safety net: this helper is for run-to-exit launches (a busy `--port`,
    // so the child adopts-and-exits or errors within the 1.5s probe budget).
    // If a caller ever spawns a launch that BINDS a free port, it would serve
    // forever and this promise would never settle; kill it and reject rather
    // than hang the test to Playwright's global timeout and orphan the server.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `spawnDevToExit: child did not exit within ${String(
            READY_TIMEOUT_MS,
          )}ms (did it bind a free port instead of a busy one?).\n--- last output ---\n${stderr}${stdout}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function spawnStudio(opts: StartStudioOptions): Promise<SpawnedStudio> {
  const port = await getEphemeralPort();
  const child = spawn(
    process.execPath,
    [
      ARKOR_BIN,
      "dev",
      "--port",
      String(port),
      ...(opts.agent ? ["--agent"] : []),
    ],
    {
      cwd: opts.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: studioChildEnv(opts),
    },
  );

  const stderr = new TailBuffer(STDIO_BUFFER_CAP);
  const stdout = new TailBuffer(STDIO_BUFFER_CAP);
  // Always buffer the child's stdio into bounded `TailBuffer`s so the
  // ready-detector below and the failure-tail in error messages have
  // something to inspect without paying O(n²) for repeated
  // `Array.join("")` over a growing chunk array. Mirroring the buffers
  // to the parent's stderr is opt-in via `STUDIO_E2E_DEBUG` to keep CI
  // logs quiet by default; set the env var while iterating on the
  // harness or chasing a flake; turbo.json declares it so toggling
  // busts the task cache.
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr.append(d);
    if (process.env.STUDIO_E2E_DEBUG) {
      process.stderr.write(`[arkor dev:err pid=${String(child.pid)}] ${d}`);
    }
  });
  child.stdout.on("data", (d: string) => {
    stdout.append(d);
    if (process.env.STUDIO_E2E_DEBUG) {
      process.stderr.write(`[arkor dev:out pid=${String(child.pid)}] ${d}`);
    }
  });
  if (process.env.STUDIO_E2E_DEBUG) {
    child.on("exit", (code, signal) => {
      process.stderr.write(
        `[arkor dev:exit pid=${String(child.pid)}] code=${String(code)} signal=${String(signal)}\n`,
      );
    });
  }

  const url = `http://127.0.0.1:${String(port)}`;

  // Wait for the ready line on stdout; surface stderr on hang so a
  // failed launch (missing assets, port collision after the eph-port
  // race, OAuth-only deployment, …) shows up as a useful error.
  //
  // Settling cleanup applies to all three exits: success, timeout,
  // premature child exit. Listeners are removed every time so the
  // already-settled promise can't fire again, and on rejection we
  // tear the child down via `makeKill`; otherwise a timeout would
  // throw out of `spawnStudio()` before the caller could obtain a
  // handle, leaving an orphaned `arkor dev` running on the runner.
  const kill = makeKill(child);
  // Combine the two tail buffers into a 2 KiB error excerpt. Reading
  // both via `tail()` is O(cap), not O(total bytes), so this stays
  // cheap regardless of how chatty the child has been.
  const errorTail = (): string => `${stderr.tail(1000)}${stdout.tail(1000)}`;
  // Agent mode waits for the session-file line (which follows the ready
  // line from the same writer) so the path is guaranteed to be in the
  // buffer once we settle; plain mode keeps the classic ready line.
  const readyPattern = opts.agent
    ? AGENT_SESSION_LINE_PATTERN
    : READY_LINE_PATTERN;
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: string) => {
        // Test the chunk first (handles the line landing in one read)
        // and fall back to the rolling buffer (handles the rare split
        // where "Arkor Studio" and "running on" arrive in two chunks).
        if (readyPattern.test(chunk) || readyPattern.test(stdout.toString())) {
          settle(resolve);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(() =>
          reject(
            new Error(
              `arkor dev exited before signalling ready (code=${String(code)}, signal=${String(signal)}).\n--- last output ---\n${errorTail()}`,
            ),
          ),
        );
      };
      // `ChildProcess` emits `error` for spawn-time failures (ENOENT,
      // EACCES, EINVAL on the bin path): these don't trigger `exit`
      // and would otherwise become an unhandled exception that kills
      // the Playwright worker. Reject with the OS error so the
      // failure surfaces as a useful message instead of a 30s
      // timeout-or-crash.
      const onError = (err: Error) => {
        settle(() =>
          reject(
            new Error(
              `Failed to spawn arkor dev: ${err.message}\n--- last output ---\n${errorTail()}`,
              { cause: err },
            ),
          ),
        );
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `Timed out waiting for "${readyPattern.source}" on stdout from arkor dev.\n--- last output ---\n${errorTail()}`,
            ),
          ),
        );
      }, READY_TIMEOUT_MS);
      let settled = false;
      function settle(action: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        action();
      }
      child.stdout.on("data", onData);
      child.on("exit", onExit);
      child.on("error", onError);
      // The buffering `child.stdout.on("data", …)` listener attached
      // earlier may have already absorbed the "Arkor Studio running
      // on …" line by the time we get here: when the child writes
      // it on the very first event-loop tick after spawn, the data
      // can land in `stdout` before this promise body runs. If no
      // further stdout follows (the steady-state for `arkor dev`),
      // `onData` would never fire and we'd hang until
      // `READY_TIMEOUT_MS`. Probe the rolling buffer once after
      // attaching listeners to catch that pre-buffered line.
      if (readyPattern.test(stdout.toString())) {
        settle(resolve);
      }
    });
  } catch (err) {
    await kill();
    throw err;
  }

  // In agent mode the wait above settled on the session-file line, so the
  // rolling buffer is guaranteed to still contain it (the cap is far above
  // the three-line startup output).
  const sessionFile = opts.agent
    ? AGENT_SESSION_LINE_PATTERN.exec(stdout.toString())?.[1]
    : undefined;
  if (opts.agent && sessionFile === undefined) {
    await kill();
    throw new Error(
      `Agent mode was requested but no session-file line was found on stdout.\n--- last output ---\n${errorTail()}`,
    );
  }

  return { child, url, kill, stderr, stdout, sessionFile };
}

/**
 * Fetch the served index.html once, parse the per-launch token out of
 * the injected `<meta name="arkor-studio-token" content="...">` tag,
 * and return it. The Studio server side-effects the meta tag at
 * request time (`server.ts:85-90`); reading
 * `~/.arkor/studio-token` directly would couple to a persistence path
 * that's allowed to fail (CLI swallows errors when HOME is read-only).
 */
async function readMetaToken(url: string): Promise<string> {
  const res = await fetch(`${url}/`);
  if (!res.ok) {
    throw new Error(
      `Studio root returned ${String(res.status)} ${res.statusText}`,
    );
  }
  const html = await res.text();
  const match =
    /<meta\s+name=["']arkor-studio-token["']\s+content=["']([^"']+)["']/.exec(
      html,
    );
  if (!match) {
    throw new Error(
      `Could not find <meta name="arkor-studio-token"> in served HTML`,
    );
  }
  return match[1];
}

export async function startStudio(
  opts: StartStudioOptions,
): Promise<StudioHandle> {
  const { url, kill, sessionFile } = await spawnStudio(opts);
  let token: string;
  try {
    // `arkor dev` writes the ready line before `http.Server.listen()`
    // finishes binding; wait for the port to actually accept TCP
    // connections before any fetch. See `waitForPort` comment.
    const port = Number(new URL(url).port);
    await waitForPort(port);
    token = await readMetaToken(url);
  } catch (err) {
    // Reuse the same SIGINT + SIGKILL-fallback teardown the handle
    // exposes; awaiting it prevents an orphaned `arkor dev` from
    // surviving a failed setup and interfering with the next test.
    await kill();
    throw err;
  }

  return { url, token, sessionFile, kill };
}
