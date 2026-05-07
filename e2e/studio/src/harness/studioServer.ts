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
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(fallback);
        resolve();
      });
      child.kill("SIGINT");
    });
  };
}

interface SpawnedStudio {
  child: ChildProcess;
  url: string;
  stderr: string[];
  stdout: string[];
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

  const stderr: string[] = [];
  const stdout: string[] = [];
  // Forward child stderr/stdout to the Playwright reporter when a test
  // fails — `console.error` lines are captured into the trace's logs.
  child.stderr?.setEncoding("utf8");
  child.stdout?.setEncoding("utf8");
  // Forwarding child stdio through Playwright's reporter is gated on
  // STUDIO_E2E_DEBUG to keep test logs quiet by default. Set the env
  // var when iterating on the harness or debugging a flake.
  child.stderr?.on("data", (d: string) => {
    stderr.push(d);
    if (process.env.STUDIO_E2E_DEBUG) {
      process.stderr.write(`[arkor dev:err pid=${child.pid}] ${d}`);
    }
  });
  child.stdout?.on("data", (d: string) => {
    stdout.push(d);
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
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const tail = stderr.concat(stdout).join("").slice(-2_000);
      reject(
        new Error(
          `Timed out waiting for "${READY_LINE_PATTERN}" on stdout from arkor dev.\n--- last output ---\n${tail}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    const onData = (chunk: string) => {
      if (READY_LINE_PATTERN.test(chunk) || READY_LINE_PATTERN.test(stdout.join(""))) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const tail = stderr.concat(stdout).join("").slice(-2_000);
      reject(
        new Error(
          `arkor dev exited before signalling ready (code=${code}, signal=${signal}).\n--- last output ---\n${tail}`,
        ),
      );
    });
  });

  return { child, url, stderr, stdout };
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
  const { child, url } = await spawnStudio(opts);
  const kill = makeKill(child);
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
