import type { JobConfig } from "arkor";

/**
 * Result of probing an executable (`uv --version`, `nvidia-smi`, ...).
 * `ok` means the process spawned and exited 0 within the timeout.
 */
export interface ExecProbeResult {
  ok: boolean;
  /** Trimmed stdout when `ok`; empty otherwise. */
  stdout: string;
  /** Human-readable failure description when not `ok`. */
  error?: string;
}

export type ExecProbe = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ExecProbeResult>;

/**
 * Everything a backend may consult during preflight. Platform and arch are
 * passed as values (not read from `process`) so tests can exercise every
 * combination on any machine; the same pattern create-arkor uses for its
 * platform-specific path handling.
 */
export interface PreflightEnv {
  platform: NodeJS.Platform;
  arch: string;
  execProbe: ExecProbe;
}

export type PreflightResult =
  | { ok: true }
  | {
      ok: false;
      /** Why this backend cannot run here (shown to the user). */
      reason: string;
      /** Optional follow-up instruction (install command, docs link). */
      remediation?: string;
    };

/**
 * A concrete child-process invocation. Backends produce these; the generic
 * runner / inference manager spawns them. Keeping the shape data-only is what
 * makes the Node side backend-agnostic.
 */
export interface RunSpec {
  command: string;
  argv: string[];
  /** Extra environment merged over the inherited one. */
  env?: Record<string, string>;
  cwd?: string;
}

/** Filesystem layout of a single training run, owned by the job store. */
export interface TrainRunPaths {
  /** `.arkor/local/jobs/<jobId>` */
  jobDir: string;
  /** `<jobDir>/run.json`, the shim's input. */
  runJsonPath: string;
  /** `<jobDir>/adapters`, where the shim writes `step-<N>/` and `final/`. */
  adaptersDir: string;
  /** `<jobDir>/data`, scratch space for prepared datasets. */
  dataDir: string;
  /** Directory holding the bundled Python shims (`<dist>/shims`). */
  shimDir: string;
}

export type ConfigValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Everything the runner needs to launch one training run: the process to
 * spawn, the `run.json` payload the shim reads, and non-fatal notes for the
 * job's console log. Keeping the payload here (instead of having the runner
 * guess at backend-specific mapping) is what confines JobConfig knowledge to
 * the backend.
 */
export interface TrainRun {
  spec: RunSpec;
  /** JSON-serialisable payload written to `run.json` before spawning. */
  runJson: Record<string, unknown>;
  /** Non-fatal notes (ignored fields etc.), appended to `console.log`. */
  warnings: string[];
}

/**
 * A local training backend. MLX (Apple Silicon) is the first implementation;
 * future CUDA / ROCm backends implement the same interface plus a Python shim
 * speaking the JSON-line protocol in `protocol.ts`, and register themselves
 * in `backends/registry.ts`. Nothing else in this package needs to change.
 *
 * All platform knowledge lives inside `preflight`: generic code never
 * branches on `process.platform`.
 */
export interface LocalTrainingBackend {
  /** Stable identifier used by `--backend <id>` and job records. */
  id: string;
  /** Human-facing name shown in CLI output. */
  displayName: string;
  preflight(env: PreflightEnv): Promise<PreflightResult>;
  /**
   * Reject configs this backend cannot honour, with one message per field.
   * Runs before any process spawns so both the SDK and Studio get the same
   * fast, precise 400.
   */
  validateConfig(config: JobConfig): ConfigValidation;
  buildTrainRun(args: { config: JobConfig; paths: TrainRunPaths }): TrainRun;
  /** Absent when the backend cannot serve inference. */
  inference?: {
    buildServerSpec(args: {
      model: string;
      adapterPath: string | null;
      host: string;
      port: number;
      shimDir: string;
    }): RunSpec;
  };
}
