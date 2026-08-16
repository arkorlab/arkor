import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { InferenceManager } from "./inference";
import { startLocalServer } from "./server";

import type { LocalServer } from "./server";

/**
 * Coupling contract with the `arkor` CLI.
 *
 * The CLI dynamically imports `@arkor/local` from the user's project and
 * checks this version before calling anything else. Bump it when
 * {@link createLocalRuntime}'s surface changes incompatibly; the CLI turns a
 * mismatch into an actionable "upgrade arkor / upgrade @arkor/local" error
 * instead of a TypeError deep inside a training run.
 */
export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1;

export interface StartRuntimeServerOptions {
  /** Project root; `.arkor/local/` lives beneath it. */
  cwd: string;
  /** Backend id override (`--backend <id>`); auto-detects when absent. */
  backendId?: string;
}

export interface LocalRuntime {
  protocolVersion: number;
  /**
   * Preflight, pick a backend, and boot the local training server on an
   * ephemeral loopback port. The returned URL and token become the
   * `ARKOR_LOCAL_SERVER_URL` / `ARKOR_LOCAL_SERVER_TOKEN` hand-off.
   */
  startServer(options: StartRuntimeServerOptions): Promise<LocalServer>;
}

/**
 * Entry point the arkor CLI calls after loading this package. Wires the
 * production pieces together: bundled shim directory, job store under the
 * project's `.arkor/local/`, and the inference manager.
 */
export function createLocalRuntime(): LocalRuntime {
  // `dist/shims/` is copied next to the bundled JS at build time
  // (scripts/copy-shims.mjs), so it resolves as a sibling of this file.
  const shimDir = fileURLToPath(new URL("shims", import.meta.url));
  return {
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    startServer: (options: StartRuntimeServerOptions) =>
      startLocalServer({
        cwd: options.cwd,
        backendId: options.backendId,
        shimDir,
        chatProxyFactory: ({ backend }) =>
          new InferenceManager({
            backend,
            shimDir,
            logFile: join(options.cwd, ".arkor", "local", "inference.log"),
          }),
      }),
  };
}

export { buildLocalApp, startLocalServer } from "./server";
export type {
  ChatProxy,
  LocalAppOptions,
  LocalServer,
  StartLocalServerOptions,
} from "./server";
export { InferenceManager } from "./inference";
export type { InferenceManagerOptions } from "./inference";
export { JobStore, isTerminalStatus } from "./store";
export type { JobRecord, StoredEvent } from "./store";
export { RunManager } from "./runner";
export type { RunManagerOptions } from "./runner";
export {
  PROTOCOL_MARKER,
  SHIM_PROTOCOL_VERSION,
  parseProtocolLine,
  toStreamEvent,
} from "./protocol";
export type {
  LocalStreamEvent,
  ParsedProtocolLine,
  ShimEvent,
} from "./protocol";
export { mlxBackend, MLX_LM_SPEC } from "./backends/mlx";
export { LOCAL_BACKENDS } from "./backends/registry";
export {
  BackendSelectionError,
  UV_INSTALL_HINT,
  currentPreflightEnv,
  defaultExecProbe,
  probeUv,
  selectBackend,
} from "./preflight";
export type {
  ConfigValidation,
  ExecProbe,
  ExecProbeResult,
  LocalTrainingBackend,
  PreflightEnv,
  PreflightResult,
  RunSpec,
  TrainRun,
  TrainRunPaths,
} from "./backends/types";
