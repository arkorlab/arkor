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

/**
 * Wire shape sent to the cloud API's job-create endpoint. Internal — users
 * compose a `TrainerInput` and the SDK translates to this.
 */
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

/**
 * LoRA / quantisation knobs. Grouped here because they cluster naturally as a
 * single concept ("how is the adapter trained?").
 */
export interface LoraConfig {
  /** LoRA rank (often 8 / 16 / 32). */
  r: number;
  /** LoRA alpha (often 2× r). */
  alpha: number;
  /** Maximum sequence length (truncates samples beyond this). */
  maxLength?: number;
  /** Load the base model in 4-bit quantisation (QLoRA). */
  loadIn4bit?: boolean;
}

/**
 * User-facing input to `createTrainer`. Flat by design so the common shape
 * reads like a config object; lifecycle handlers are grouped under
 * `callbacks` for legibility.
 */
export interface TrainerInput {
  /** Human-readable run name; shown in Studio + Web UI. */
  name: string;
  /** Base model identifier (HuggingFace path, etc.). */
  model: string;
  /** Dataset source (HuggingFace name or blob URL). */
  dataset: DatasetSource;
  /** LoRA / quantisation knobs. */
  lora?: LoraConfig;
  /** Cap training at this many gradient steps. */
  maxSteps?: number;
  numTrainEpochs?: number;
  learningRate?: number;
  batchSize?: number;
  optim?: string;
  lrSchedulerType?: string;
  weightDecay?: number;
  /**
   * Forwarded to the cloud API as-is. Reserved for fields that aren't yet
   * first-classed in this SDK. Prefer the dedicated fields above when present.
   */
  warmupSteps?: unknown;
  loggingSteps?: unknown;
  saveSteps?: unknown;
  evalSteps?: unknown;
  trainOnResponsesOnly?: unknown;
  datasetFormat?: unknown;
  datasetSplit?: unknown;
  /** Optional lifecycle callbacks. */
  callbacks?: Partial<TrainerCallbacks>;
  /** Abort signal to stop polling and cancel the in-flight job. */
  abortSignal?: AbortSignal;
}

export interface Trainer {
  /** The run name supplied by the user, copied here for discovery. */
  readonly name: string;
  /** Submit the job. Returns the created job id. */
  start(): Promise<{ jobId: string }>;
  /** Resolve when the job reaches a terminal status. */
  wait(): Promise<TrainingResult>;
  /** Best-effort cancel; resolves once the cloud API accepts the request. */
  cancel(): Promise<void>;
}

/**
 * Umbrella manifest produced by `createArkor`. Currently a frozen descriptor
 * of the project's primitives. The shape is intentionally opaque — operation
 * methods may be added later without breaking the user-facing API.
 */
export interface Arkor {
  /** Runtime discriminator used by `isArkor` and `arkor build` discovery. */
  readonly _kind: "arkor";
  readonly trainer?: Trainer;
  // future: readonly deploy?: Deploy;
  // future: readonly eval?: Eval;
}

/** User-facing input to `createArkor`. Role-fixed keys. */
export interface ArkorInput {
  trainer?: Trainer;
  // future: deploy?: Deploy;
  // future: eval?: Eval;
}

export interface ArkorProjectState {
  orgSlug: string;
  projectSlug: string;
  projectId: string;
}
