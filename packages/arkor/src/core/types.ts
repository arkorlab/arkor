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
  /**
   * Smoke-test mode. When true, the trainer truncates the dataset to a small
   * sample and caps the number of training steps so the run finishes in a
   * couple of minutes while still exercising every stage of the pipeline
   * (data load, chat-template render, training loop, checkpoint upload, event
   * stream). Use to validate a dataset / config before committing to a full run.
   */
  dryRun?: boolean;
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

/**
 * One entry in a tool-call delta or completed assistant message.
 *
 * Snake-case (`tool_calls`, `tool_call_id`) matches the OpenAI / vLLM wire
 * format and is forwarded verbatim through every layer (SDK → cloud-api →
 * control-plane → vLLM worker), so messages can round-trip a chat history
 * without re-keying.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments string — partial deltas may be streamed. */
    arguments: string;
  };
}

/**
 * Discriminated union over the four OpenAI message roles, including tool-
 * calling shapes. Assistant messages may carry `tool_calls` and omit
 * `content` (the common "pure tool call" turn shape). Tool messages are
 * the model's view of a tool's response and are paired with the
 * originating `tool_call_id`.
 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      /** May be `null` (or omitted) when the turn is purely a tool call. */
      content?: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string };

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema object describing the tool arguments. */
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * OpenAI-compatible tool selection. `"auto"` (the documented default when
 * `tools` is present) lets the model decide; `"required"` forces it to
 * call one of the supplied tools; `"none"` keeps tools in context but
 * disables calling. The object form pins the call to a specific function.
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

/**
 * vLLM's `StructuredOutputsParams` — used for constraints that
 * `response_format` can't express (regex, choice lists, custom grammars).
 * Mutually-exclusive: pick at most one of `json` / `regex` / `choice` /
 * `grammar` / `json_object` / `structural_tag`. The remaining knobs tune
 * backend-specific behaviour. Field names are snake_case to match vLLM's
 * wire format exactly so the worker forwards verbatim.
 */
export interface StructuredOutputs {
  json?: string | Record<string, unknown>;
  regex?: string;
  choice?: string[];
  grammar?: string;
  json_object?: boolean;
  structural_tag?: string;
  disable_any_whitespace?: boolean;
  disable_additional_properties?: boolean;
  whitespace_pattern?: string;
}

export interface InferArgs {
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Default: true. Set false to get a single JSON body instead of SSE. */
  stream?: boolean;
  /**
   * Function-calling tool definitions. When present without an explicit
   * `toolChoice`, the OpenAI-compatible default `"auto"` applies; the
   * underlying endpoint must be configured for auto-tool extraction or
   * the request returns a `400 tool_calling_not_configured`.
   */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** OpenAI-compatible response_format (e.g. JSON Schema). */
  responseFormat?: ResponseFormat;
  /**
   * vLLM-specific structured outputs (regex / choice / grammar) for
   * constraints not covered by `responseFormat`. `responseFormat` is
   * preferred when both can express the same constraint, since it's the
   * cross-provider standard.
   */
  structuredOutputs?: StructuredOutputs;
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
  /**
   * Run a smoke-test instead of a full training run. The cloud trainer
   * truncates the dataset and caps the number of steps so the job finishes in
   * a couple of minutes; useful for validating a new dataset or config before
   * committing to a long run.
   */
  dryRun?: boolean;
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
 * Project entry-point manifest produced by `createArkor`. Currently a frozen descriptor
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
