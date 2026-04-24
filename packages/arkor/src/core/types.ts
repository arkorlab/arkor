/**
 * Public types for the arkor SDK.
 *
 * Job/event shapes are declared structurally; the server is the authority for
 * field presence. Runtime validation lives in `schemas.ts`.
 */
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface HuggingfaceDatasetSource {
  type: "huggingface";
  name: string;
  split?: string;
  subset?: string;
}

export interface BlobDatasetSource {
  type: "blob";
  url: string;
  token?: string;
}

export type DatasetSource = HuggingfaceDatasetSource | BlobDatasetSource;

export interface JobConfig {
  model: string;
  datasetSource: DatasetSource;
  datasetFormat?: unknown;
  maxSteps?: number;
  numTrainEpochs?: number;
  learningRate?: number;
  batchSize?: number;
  optim?: string;
  lrSchedulerType?: string;
  weightDecay?: number;
  warmupSteps?: unknown;
  loggingSteps?: unknown;
  saveSteps?: unknown;
  evalSteps?: unknown;
  loraR?: number;
  loraAlpha?: number;
  maxLength?: number;
  loadIn4bit?: boolean;
  trainOnResponsesOnly?: unknown;
  datasetSplit?: unknown;
}

export interface TrainingJob {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  status: JobStatus;
  config: JobConfig;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface TrainingResult {
  job: TrainingJob;
  artifacts: unknown[];
}

export interface TrainingLogContext {
  step: number;
  loss: number | null;
  evalLoss: number | null;
  learningRate: number | null;
  epoch: number | null;
  samplesPerSecond: number | null;
  job: TrainingJob;
}

export interface InferArgs {
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Default: true. Set false to get a single JSON body instead of SSE. */
  stream?: boolean;
  signal?: AbortSignal;
}

export interface CheckpointContext {
  step: number;
  adapter: { kind: "checkpoint"; jobId: string; step: number };
  job: TrainingJob;
  /**
   * Fire an inference request bound to this checkpoint adapter. Returns the
   * raw `Response` so callers can `await response.text()` or stream from
   * `response.body`.
   */
  infer: (args: InferArgs) => Promise<Response>;
  /** Raw event artifacts as sent by the server (optional). */
  artifacts?: unknown[];
}

export interface TrainerCallbacks {
  onStarted: (ctx: { job: TrainingJob }) => unknown | Promise<unknown>;
  onLog: (ctx: TrainingLogContext) => unknown | Promise<unknown>;
  onCheckpoint: (ctx: CheckpointContext) => unknown | Promise<unknown>;
  onCompleted: (ctx: {
    job: TrainingJob;
    artifacts: unknown[];
  }) => unknown | Promise<unknown>;
  onFailed: (ctx: {
    job: TrainingJob;
    error: string;
  }) => unknown | Promise<unknown>;
}

export interface TrainerOptions {
  /** Human-readable run name, shown in Studio + Web UI. */
  name: string;
  /** Training configuration; matches the cloud API's jobConfigSchema. */
  config: JobConfig;
  /**
   * Optional lifecycle callbacks. `onLog` / `onCheckpoint` land in a later phase
   * (they need an SSE event stream on the server side) and are accepted here but
   * not yet invoked.
   */
  callbacks?: Partial<TrainerCallbacks>;
  /** Abort signal to stop polling and cancel the in-flight job. */
  abortSignal?: AbortSignal;
}

export interface Trainer {
  /** Submit the job. Returns the created job id. */
  start(): Promise<{ jobId: string }>;
  /** Resolve when the job reaches a terminal status. */
  wait(): Promise<TrainingResult>;
  /** Best-effort cancel; resolves once the cloud API accepts the request. */
  cancel(): Promise<void>;
}

export interface ArkorProjectState {
  orgSlug: string;
  projectSlug: string;
  projectId: string;
}
