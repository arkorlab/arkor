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
}

export interface StudioHandle {
  /** `http://127.0.0.1:<port>` — the live Studio. */
  url: string;
  /** Per-launch CSRF token, parsed out of the served `index.html`. */
  token: string;
  /** Send SIGINT and await child exit. Idempotent. */
  kill: () => Promise<void>;
}

const READY_LINE_PATTERN = /Arkor Studio running on/;
const READY_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 50;
const PORT_POLL_TIMEOUT_MS = 10_000;
/**
 * Cap on the rolling stdio buffers below. ~4 KiB is well above the
 * ready line (~50 bytes) and the 2000-char error tail we surface on
 * failure, while preventing the buffer from growing unboundedly under
 * `STUDIO_E2E_DEBUG` runs (where the child can emit lots of output).
 */
const STDIO_BUFFER_CAP = 4_096;

/**
 * Bounded string buffer that appends in amortised O(1) and exposes
 * the most-recent ~`cap` bytes via `toString()`. Used in place of an
 * unbounded `string[]` so the ready-line detector — which runs on
 * every stdout chunk — doesn't pay O(n²) for `Array.join("")` as the
 * child accumulates output.
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
 * grows on a cold one. Poll a bare TCP connect until the kernel accepts —
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
    await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
  }
  throw new Error(`Port ${port} did not become ready within ${PORT_POLL_TIMEOUT_MS}ms`);
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
  return async () => {
    if (killed) return;
    killed = true;
    await new Promise<void>((resolve) => {
      // Declare the SIGKILL fallback handle *before* defining
      // `onExit`. The exit listener is attached before SIGINT so it
      // can't miss a concurrent exit, but if the child happens to
      // exit between attaching the listener and the `setTimeout(...)`
      // call below, `onExit` runs while `fallback` is still in its
      // temporal dead zone — accessing it would throw a
      // `ReferenceError` and hang the teardown. Pre-declared `let`
      // (initialised to `null`) sidesteps the TDZ; the
      // `clearTimeout(null)` short-circuit makes the no-fallback
      // path harmless.
      let fallback: ReturnType<typeof setTimeout> | null = null;
      // Register `exit` *before* re-checking termination state and
      // *before* delivering SIGINT. If the child happens to exit in
      // the gap between the early-return check and the listener
      // attach, `once("exit")` would miss the event and this promise
      // would hang forever, stalling the whole Playwright run.
      // Registering first lets the listener catch any exit that
      // arrives concurrently; the post-register `exitCode/signalCode`
      // check covers the case where the child had already exited
      // before this callback ran.
      const onExit = () => {
        if (fallback !== null) clearTimeout(fallback);
        resolve();
      };
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onExit);
        resolve();
        return;
      }
      // `child.killed` flips true the moment Node *delivers* a
      // signal, not when the child actually exits. Probe the real
      // termination state via `exitCode` / `signalCode`; both stay
      // null until the child reports `exit`.
      fallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5_000);
      child.kill("SIGINT");
    });
  };
}

interface SpawnedStudio {
  child: ChildProcess;
  url: string;
  /** Idempotent teardown for `child` — exposed so `startStudio` reuses
   *  the same instance instead of allocating a second wrapper around
   *  the same process. */
  kill: () => Promise<void>;
  stderr: TailBuffer;
  stdout: TailBuffer;
}

async function spawnStudio(
  opts: StartStudioOptions,
): Promise<SpawnedStudio> {
  const port = await getEphemeralPort();
  // `runCli` in e2e/cli also strips parent's `npm_config_*` to keep the
  // child's pm detection deterministic; for `arkor dev` it doesn't
  // matter (it never installs anything), but mirroring the policy
  // avoids a class of surprises if the CLI later starts reading those.
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const lower = k.toLowerCase();
    if (lower.startsWith("npm_config_") || lower.startsWith("pnpm_config_")) {
      continue;
    }
    cleanEnv[k] = v;
  }
  const child = spawn(
    process.execPath,
    [ARKOR_BIN, "dev", "--port", String(port)],
    {
      cwd: opts.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...cleanEnv,
        CI: "1",
        HOME: opts.home,
        // Mirror HOME onto USERPROFILE so the spawned CLI's `os.homedir()`
        // resolves to the test temp dir on Windows too — see the matching
        // comment in e2e/cli/src/spawn-cli.ts.
        USERPROFILE: opts.home,
        ARKOR_CLOUD_API_URL: opts.cloudApiUrl,
        // Defence in depth: if anything anonymous-bootstrapped slips
        // through credential pre-seeding, telemetry posts must not hit
        // the real PostHog endpoint from CI.
        ARKOR_TELEMETRY_DISABLED: "1",
        npm_config_user_agent: "",
      },
    },
  );

  const stderr = new TailBuffer(STDIO_BUFFER_CAP);
  const stdout = new TailBuffer(STDIO_BUFFER_CAP);
  // Always buffer the child's stdio into bounded `TailBuffer`s so the
  // ready-detector below and the failure-tail in error messages have
  // something to inspect without paying O(n²) for repeated
  // `Array.join("")` over a growing chunk array. Mirroring the buffers
  // to the parent's stderr is opt-in via `STUDIO_E2E_DEBUG` to keep CI
  // logs quiet by default — set the env var while iterating on the
  // harness or chasing a flake; turbo.json declares it so toggling
  // busts the task cache.
  child.stderr?.setEncoding("utf8");
  child.stdout?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderr.append(d);
    if (process.env.STUDIO_E2E_DEBUG) {
      process.stderr.write(`[arkor dev:err pid=${child.pid}] ${d}`);
    }
  });
  child.stdout?.on("data", (d: string) => {
    stdout.append(d);
    if (process.env.STUDIO_E2E_DEBUG) {
      process.stderr.write(`[arkor dev:out pid=${child.pid}] ${d}`);
    }
  });
  if (process.env.STUDIO_E2E_DEBUG) {
    child.on("exit", (code, signal) => {
      process.stderr.write(
        `[arkor dev:exit pid=${child.pid}] code=${code} signal=${signal}\n`,
      );
    });
  }

  const url = `http://127.0.0.1:${port}`;

  // Wait for the ready line on stdout; surface stderr on hang so a
  // failed launch (missing assets, port collision after the eph-port
  // race, OAuth-only deployment, …) shows up as a useful error.
  //
  // Settling cleanup applies to all three exits: success, timeout,
  // premature child exit. Listeners are removed every time so the
  // already-settled promise can't fire again, and on rejection we
  // tear the child down via `makeKill` — otherwise a timeout would
  // throw out of `spawnStudio()` before the caller could obtain a
  // handle, leaving an orphaned `arkor dev` running on the runner.
  const kill = makeKill(child);
  // Combine the two tail buffers into a 2 KiB error excerpt. Reading
  // both via `tail()` is O(cap), not O(total bytes), so this stays
  // cheap regardless of how chatty the child has been.
  const errorTail = (): string =>
    `${stderr.tail(1_000)}${stdout.tail(1_000)}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: string) => {
        // Test the chunk first (handles the line landing in one read)
        // and fall back to the rolling buffer (handles the rare split
        // where "Arkor Studio" and "running on" arrive in two chunks).
        if (READY_LINE_PATTERN.test(chunk) || READY_LINE_PATTERN.test(stdout.toString())) {
          settle(resolve);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(() =>
          reject(
            new Error(
              `arkor dev exited before signalling ready (code=${code}, signal=${signal}).\n--- last output ---\n${errorTail()}`,
            ),
          ),
        );
      };
      // `ChildProcess` emits `error` for spawn-time failures (ENOENT,
      // EACCES, EINVAL on the bin path) — these don't trigger `exit`
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
              `Timed out waiting for "${READY_LINE_PATTERN}" on stdout from arkor dev.\n--- last output ---\n${errorTail()}`,
            ),
          ),
        );
      }, READY_TIMEOUT_MS);
      let settled = false;
      function settle(action: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        action();
      }
      child.stdout?.on("data", onData);
      child.on("exit", onExit);
      child.on("error", onError);
      // The buffering `child.stdout.on("data", …)` listener attached
      // earlier may have already absorbed the "Arkor Studio running
      // on …" line by the time we get here — when the child writes
      // it on the very first event-loop tick after spawn, the data
      // can land in `stdout` before this promise body runs. If no
      // further stdout follows (the steady-state for `arkor dev`),
      // `onData` would never fire and we'd hang until
      // `READY_TIMEOUT_MS`. Probe the rolling buffer once after
      // attaching listeners to catch that pre-buffered line.
      if (READY_LINE_PATTERN.test(stdout.toString())) {
        settle(resolve);
      }
    });
  } catch (err) {
    await kill();
    throw err;
  }

  return { child, url, kill, stderr, stdout };
}

/**
 * Fetch the served index.html once, parse the per-launch token out of
 * the injected `<meta name="arkor-studio-token" content="...">` tag,
 * and return it. The Studio server side-effects the meta tag at
 * request time (`server.ts:85-90`) — reading
 * `~/.arkor/studio-token` directly would couple to a persistence path
 * that's allowed to fail (CLI swallows errors when HOME is read-only).
 */
async function readMetaToken(url: string): Promise<string> {
  const res = await fetch(`${url}/`);
  if (!res.ok) {
    throw new Error(`Studio root returned ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const match = html.match(
    /<meta\s+name=["']arkor-studio-token["']\s+content=["']([^"']+)["']/,
  );
  if (!match) {
    throw new Error(
      `Could not find <meta name="arkor-studio-token"> in served HTML`,
    );
  }
  return match[1]!;
}

export async function startStudio(
  opts: StartStudioOptions,
): Promise<StudioHandle> {
  const { url, kill } = await spawnStudio(opts);
  let token: string;
  try {
    // `arkor dev` writes the ready line before `http.Server.listen()`
    // finishes binding — wait for the port to actually accept TCP
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

  return { url, token, kill };
}
