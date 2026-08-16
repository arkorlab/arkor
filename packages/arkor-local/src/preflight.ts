import { spawn, type ChildProcess } from "node:child_process";

import type {
  ExecProbe,
  ExecProbeResult,
  LocalTrainingBackend,
  PreflightEnv,
  PreflightResult,
} from "./backends/types";

/**
 * Shown whenever uv is missing. uv is a hard prerequisite because it is what
 * resolves the Python side (mlx-lm and friends) into a cached ephemeral
 * environment; arkor deliberately does not install uv itself (a package
 * manager silently installing another package manager is the kind of
 * surprise this project avoids).
 */
export const UV_INSTALL_HINT =
  "Install uv with `brew install uv` or " +
  "`curl -LsSf https://astral.sh/uv/install.sh | sh` " +
  "(https://docs.astral.sh/uv/getting-started/installation/), then re-run. " +
  "arkor does not install uv for you.";

/**
 * Default {@link ExecProbe}: spawn the command, wait for exit 0 within the
 * timeout, capture stdout. Follows the hardened probe pattern from
 * cli-internal's yarn detection: settle-once guard, hard timeout with
 * best-effort SIGKILL, synchronous-spawn-failure catch, and `unref` so a
 * pending timer never holds the event loop open.
 */
export const defaultExecProbe: ExecProbe = async (command, args, timeoutMs) => {
  return new Promise<ExecProbeResult>((resolve) => {
    let resolved = false;
    const settle = (value: ExecProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        // `uv` ships a real .exe on Windows, but probes may target `.cmd`
        // shims too; matching the repo-wide spawn policy keeps this helper
        // usable for both.
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ ok: false, stdout: "", error: String(error) });
      return;
    }
    const timeoutId = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      settle({
        ok: false,
        stdout: "",
        error: `timed out after ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);
    // Optional `?.` despite the TS type: under vitest fake timers
    // `setTimeout` can return a plain numeric id and `.unref()` would throw.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    timeoutId.unref?.();
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      settle({ ok: false, stdout: "", error: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        settle({ ok: true, stdout: stdout.trim() });
        return;
      }
      settle({
        ok: false,
        stdout: "",
        error:
          `exited with code ${String(code)}` +
          (stderr.trim() ? `: ${stderr.trim()}` : ""),
      });
    });
  });
};

const UV_PROBE_TIMEOUT_MS = 5000;

/** Check that `uv` is runnable. Shared by every uv-based backend. */
export async function probeUv(execProbe: ExecProbe): Promise<PreflightResult> {
  const result = await execProbe("uv", ["--version"], UV_PROBE_TIMEOUT_MS);
  if (result.ok) return { ok: true };
  return {
    ok: false,
    reason: `uv is not available on PATH (${result.error ?? "unknown error"})`,
    remediation: UV_INSTALL_HINT,
  };
}

/** Build a {@link PreflightEnv} for the current process. */
export function currentPreflightEnv(): PreflightEnv {
  return {
    platform: process.platform,
    arch: process.arch,
    execProbe: defaultExecProbe,
  };
}

export class BackendSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendSelectionError";
  }
}

/**
 * Pick the backend to use: the requested one when `requestedId` is given
 * (its preflight must still pass), otherwise the first registered backend
 * whose preflight passes. When nothing passes, the error aggregates every
 * backend's reason so the user sees the full picture in one message instead
 * of fixing one prerequisite only to hit the next.
 */
export async function selectBackend(options: {
  backends: readonly LocalTrainingBackend[];
  env: PreflightEnv;
  requestedId?: string;
}): Promise<LocalTrainingBackend> {
  const { backends, env, requestedId } = options;
  if (requestedId) {
    const backend = backends.find((b) => b.id === requestedId);
    if (!backend) {
      const known = backends.map((b) => b.id).join(", ");
      throw new BackendSelectionError(
        `Unknown local training backend "${requestedId}". Known backends: ${known}.`,
      );
    }
    const result = await backend.preflight(env);
    if (!result.ok) {
      throw new BackendSelectionError(
        formatFailures([[backend, result]], { requested: true }),
      );
    }
    return backend;
  }

  const failures: [LocalTrainingBackend, PreflightResult & { ok: false }][] =
    [];
  for (const backend of backends) {
    const result = await backend.preflight(env);
    if (result.ok) return backend;
    failures.push([backend, result]);
  }
  throw new BackendSelectionError(formatFailures(failures, {}));
}

function formatFailures(
  failures: readonly (readonly [
    LocalTrainingBackend,
    PreflightResult & { ok: false },
  ])[],
  { requested = false }: { requested?: boolean },
): string {
  const lines = failures.map(([backend, result]) => {
    const remediation = result.remediation ? ` ${result.remediation}` : "";
    return `  ${backend.id} (${backend.displayName}): ${result.reason}.${remediation}`;
  });
  const heading = requested
    ? "The requested local training backend is not available:"
    : "No local training backend is available on this machine:";
  return `${heading}\n${lines.join("\n")}`;
}
