import { z } from "zod";

/**
 * Wire contract between the Node runner and the Python training shims.
 *
 * A shim reports progress by printing single-line JSON objects to stdout,
 * each prefixed with {@link PROTOCOL_MARKER}. Everything else on
 * stdout/stderr is treated as console output and captured to the job's
 * `console.log` file. The marker prefix is what lets library output (pip
 * resolution notes, tokenizer warnings, tqdm fallbacks) coexist with the
 * protocol on the same stream without ambiguity.
 *
 * This file is the single source of truth for the contract: a future CUDA or
 * ROCm shim emits exactly these shapes and the rest of the package works
 * unchanged.
 */
export const PROTOCOL_MARKER = "@arkor ";

/**
 * Bumped when the JSON-line contract changes incompatibly. The runner embeds
 * the expected version into `run.json`; the shim asserts it before doing any
 * work so a stale shim next to a newer runner fails loudly, not subtly.
 */
export const SHIM_PROTOCOL_VERSION = 1;

// zod v4's z.number() already rejects Infinity/NaN; only null-normalise.
const finiteOrNull = z
  .number()
  .nullish()
  .transform((v) => v ?? null);

export const shimStartedSchema = z.object({
  type: z.literal("started"),
});

export const shimLogSchema = z.object({
  type: z.literal("log"),
  step: z.number().int().nonnegative(),
  loss: finiteOrNull,
  evalLoss: finiteOrNull,
  learningRate: finiteOrNull,
  epoch: finiteOrNull,
  samplesPerSecond: finiteOrNull,
});

export const shimCheckpointSchema = z.object({
  type: z.literal("checkpoint"),
  step: z.number().int().nonnegative(),
  /** Absolute path of the normalised adapter directory for this step. */
  adapterDir: z.string().min(1),
});

export const shimCompletedSchema = z.object({
  type: z.literal("completed"),
  /** Absolute path of the final adapter directory; null for dry runs. */
  adapterDir: z
    .string()
    .min(1)
    .nullish()
    .transform((v) => v ?? null),
  metrics: z.record(z.string(), z.unknown()).optional(),
});

export const shimFailedSchema = z.object({
  type: z.literal("failed"),
  error: z.string().min(1),
  step: z.number().int().nonnegative().optional(),
});

export const shimEventSchema = z.discriminatedUnion("type", [
  shimStartedSchema,
  shimLogSchema,
  shimCheckpointSchema,
  shimCompletedSchema,
  shimFailedSchema,
]);

export type ShimEvent = z.infer<typeof shimEventSchema>;

export type ParsedProtocolLine =
  /** The line carries no marker: plain console output. */
  | { kind: "console" }
  /** A well-formed protocol event. */
  | { kind: "event"; event: ShimEvent }
  /** Marker present but the payload does not parse or validate. */
  | { kind: "invalid"; error: string };

/**
 * Classify one stdout line. Never throws: a malformed protocol line is
 * reported as `invalid` so the runner can log it and keep supervising the
 * child instead of crashing mid-training.
 */
export function parseProtocolLine(line: string): ParsedProtocolLine {
  if (!line.startsWith(PROTOCOL_MARKER)) return { kind: "console" };
  const payload = line.slice(PROTOCOL_MARKER.length);
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (error) {
    return {
      kind: "invalid",
      error: `protocol line is not valid JSON: ${String(error)}`,
    };
  }
  const parsed = shimEventSchema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "invalid",
      error: `protocol line failed validation: ${parsed.error.message}`,
    };
  }
  return { kind: "event", event: parsed.data };
}

/**
 * The SSE event shapes the arkor SDK and Studio already consume from the
 * cloud (`training.started` / `training.log` / `checkpoint.saved` /
 * `training.completed` / `training.failed`). The local server emits exactly
 * these so `trainer.wait()` and the Studio job detail page work unchanged.
 */
export interface LocalStreamEventBase {
  type: string;
  jobId: string;
  timestamp: string;
}

export type LocalStreamEvent =
  | (LocalStreamEventBase & { type: "training.started" })
  | (LocalStreamEventBase & {
      type: "training.log";
      step: number;
      loss: number | null;
      evalLoss: number | null;
      learningRate: number | null;
      epoch: number | null;
      samplesPerSecond: number | null;
    })
  | (LocalStreamEventBase & {
      type: "checkpoint.saved";
      step: number;
      artifacts: unknown[];
    })
  | (LocalStreamEventBase & {
      type: "training.completed";
      metrics?: unknown;
      artifacts: unknown[];
    })
  | (LocalStreamEventBase & {
      type: "training.failed";
      error: string;
      step?: number;
    });

/** Artifact entry attached to checkpoint / completion events. */
export interface LocalAdapterArtifact {
  type: "local-adapter";
  path: string;
}

/**
 * Translate a shim event into the SSE shape. `jobId` and `timestamp` are
 * stamped here (server side): the shim does not know its job id, and wall
 * clocks belong in exactly one place.
 */
export function toStreamEvent(
  event: ShimEvent,
  jobId: string,
  timestamp: string,
): LocalStreamEvent {
  switch (event.type) {
    case "started":
      return { type: "training.started", jobId, timestamp };
    case "log":
      return {
        type: "training.log",
        jobId,
        timestamp,
        step: event.step,
        loss: event.loss,
        evalLoss: event.evalLoss,
        learningRate: event.learningRate,
        epoch: event.epoch,
        samplesPerSecond: event.samplesPerSecond,
      };
    case "checkpoint":
      return {
        type: "checkpoint.saved",
        jobId,
        timestamp,
        step: event.step,
        artifacts: [adapterArtifact(event.adapterDir)],
      };
    case "completed":
      return {
        type: "training.completed",
        jobId,
        timestamp,
        ...(event.metrics !== undefined ? { metrics: event.metrics } : {}),
        artifacts:
          event.adapterDir === null ? [] : [adapterArtifact(event.adapterDir)],
      };
    case "failed":
      return {
        type: "training.failed",
        jobId,
        timestamp,
        error: event.error,
        ...(event.step !== undefined ? { step: event.step } : {}),
      };
  }
}

function adapterArtifact(path: string): LocalAdapterArtifact {
  return { type: "local-adapter", path };
}
