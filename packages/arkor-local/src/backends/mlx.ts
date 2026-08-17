import { join } from "node:path";

import { probeUv } from "../preflight";
import { SHIM_PROTOCOL_VERSION } from "../protocol";

import type {
  ConfigValidation,
  LocalTrainingBackend,
  PreflightEnv,
  PreflightResult,
  TrainRun,
  TrainRunPaths,
} from "./types";
import type { JobConfig } from "arkor";

/**
 * Exact mlx-lm pin used for both training and inference children.
 *
 * Pinned (not a range) on purpose:
 *   1. Reproducibility: two machines running the same arkor version train
 *      with the same Python stack.
 *   2. API stability: the training shim drives mlx-lm's tuner API, whose
 *      internals move between releases; a float pin would let a background
 *      `uv` cache refresh break training with no arkor change.
 *   3. Supply-chain hygiene: the resolved Python closure changes only when
 *      this constant is bumped deliberately (together with the shim and its
 *      fixtures).
 *
 * The `[train]` extra pulls the dataset tooling (`datasets` etc.) the shim
 * needs for HuggingFace dataset preparation.
 *
 * License note: mlx and mlx-lm are MIT; transformers / datasets are
 * Apache-2.0. The local path deliberately never installs or imports
 * unsloth (AGPL-3.0).
 */
export const MLX_LM_SPEC = "mlx-lm[train]==0.31.3";

/**
 * Optimizers the shim maps onto mlx-lm. Keys are the accepted `optim`
 * values; values are the normalised names written into `run.json`. The
 * `adamw_*` aliases exist because cloud configs written for the hosted
 * trainer commonly carry bitsandbytes-flavoured names (`adamw_8bit`); the
 * 8-bit part is a CUDA detail with no MLX equivalent, so they degrade to
 * plain adamw with a logged warning.
 */
const OPTIMIZERS: Readonly<Record<string, string>> = Object.freeze({
  adam: "adam",
  adamw: "adamw",
  muon: "muon",
  sgd: "sgd",
  adafactor: "adafactor",
});

const ADAMW_ALIAS_PATTERN = /^adamw_[a-z0-9_]+$/;

/** LR schedules the shim maps onto mlx-lm's schedule builders. */
const LR_SCHEDULES = Object.freeze(["constant", "linear", "cosine"] as const);

const DATASET_FORMATS = Object.freeze([
  "text",
  "chatml",
  "sharegpt",
  "alpaca",
  "prompt_completion",
] as const);

interface NormalisedDatasetFormat {
  type: (typeof DATASET_FORMATS)[number];
  columnMapping?: Record<string, string>;
}

interface NormalisedSteps {
  steps?: number;
  ratio?: number;
}

/**
 * The MLX backend: LoRA fine-tuning and OpenAI-compatible inference on
 * Apple Silicon via mlx-lm, resolved at run time by uv. First (and for now
 * only) entry in the backend registry; the CUDA / ROCm backends planned on
 * the roadmap implement the same interface with their own shims.
 */
export const mlxBackend: LocalTrainingBackend = {
  id: "mlx",
  displayName: "MLX (Apple Silicon)",

  async preflight(env: PreflightEnv): Promise<PreflightResult> {
    // MLX runs on Apple Silicon only: no Intel Mac support upstream, and no
    // other OS. This is the single place in the package that looks at
    // platform/arch.
    if (env.platform !== "darwin" || env.arch !== "arm64") {
      return {
        ok: false,
        reason:
          "the MLX backend requires an Apple Silicon Mac " +
          `(detected ${env.platform}/${env.arch})`,
      };
    }
    return probeUv(env.execProbe);
  },

  validateConfig(config: JobConfig): ConfigValidation {
    const errors: string[] = [];

    // null AND undefined both count as absent: configs arrive as parsed
    // JSON, where an explicit `null` is representable.
    const absent = (value: unknown): value is null | undefined =>
      value === null || value === undefined;
    if (absent(config.maxSteps) && absent(config.numTrainEpochs)) {
      errors.push(
        "maxSteps or numTrainEpochs is required for local MLX training " +
          "(an unbounded run cannot be sized)",
      );
    }
    for (const [field, value, kind] of [
      ["maxSteps", config.maxSteps, "positive integer"],
      ["numTrainEpochs", config.numTrainEpochs, "positive number"],
      ["batchSize", config.batchSize, "positive integer"],
      ["learningRate", config.learningRate, "positive number"],
      ["loraR", config.loraR, "positive integer"],
      ["loraAlpha", config.loraAlpha, "positive number"],
      ["maxLength", config.maxLength, "positive integer"],
    ] as const) {
      if (absent(value)) continue;
      const isInteger = kind === "positive integer";
      const valid =
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0 &&
        (!isInteger || Number.isInteger(value));
      if (!valid) errors.push(`${field} must be a ${kind}`);
    }

    // Boolean flags: a JS caller passing an env-derived string such as
    // "false" must not silently become truthy in the shim (a "false" dryRun
    // would skip training and still report the job completed).
    for (const [field, value] of [
      ["dryRun", config.dryRun],
      ["loadIn4bit", config.loadIn4bit],
    ] as const) {
      if (absent(value)) continue;
      if (typeof value !== "boolean") {
        errors.push(`${field} must be a boolean`);
      }
    }

    const source = validateDatasetSource(config.datasetSource);
    if (source instanceof Error) errors.push(source.message);

    const format = normaliseDatasetFormat(config.datasetFormat);
    if (format instanceof Error) errors.push(format.message);

    const optim = normaliseOptimizer(config.optim);
    if (optim instanceof Error) errors.push(optim.message);

    const schedule = normaliseLrSchedule(config.lrSchedulerType);
    if (schedule instanceof Error) errors.push(schedule.message);

    if (
      config.weightDecay !== undefined &&
      !(Number.isFinite(config.weightDecay) && config.weightDecay >= 0)
    ) {
      errors.push("weightDecay must be a non-negative number");
    }

    const warmup = normaliseWarmupSteps(config.warmupSteps);
    if (warmup instanceof Error) errors.push(warmup.message);

    for (const [field, value] of [
      ["loggingSteps", config.loggingSteps],
      ["saveSteps", config.saveSteps],
      ["evalSteps", config.evalSteps],
    ] as const) {
      const steps = normaliseSteps(field, value);
      if (steps instanceof Error) errors.push(steps.message);
    }

    const split = normaliseDatasetSplit(config.datasetSplit);
    if (split instanceof Error) errors.push(split.message);

    const mask = normaliseTrainOnResponsesOnly(config.trainOnResponsesOnly);
    if (mask instanceof Error) errors.push(mask.message);

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  buildTrainRun(args: { config: JobConfig; paths: TrainRunPaths }): TrainRun {
    const { config, paths } = args;
    const warnings: string[] = [];

    // validateConfig ran before job creation; a validation error here means
    // a caller skipped it, which is a programming error worth failing loudly.
    const validation = this.validateConfig(config);
    if (!validation.ok) {
      throw new Error(
        `buildTrainRun called with an invalid config:\n${validation.errors.join("\n")}`,
      );
    }

    const optim = expect(normaliseOptimizer(config.optim));
    if (config.optim !== undefined && optim.aliased) {
      warnings.push(
        `optim "${config.optim}" has no MLX equivalent for its ` +
          `quantisation suffix; using plain "${optim.value}" instead`,
      );
    }
    // Only a truthy value asked for something the backend cannot honour;
    // `loadIn4bit: false` matches the behaviour and deserves no noise.
    if (config.loadIn4bit === true) {
      warnings.push(
        "loadIn4bit is ignored by the MLX backend: quantisation is a " +
          "property of the chosen model. Pick a pre-quantised model " +
          "(for example an mlx-community *-4bit conversion) instead",
      );
    }

    const runJson: Record<string, unknown> = {
      protocolVersion: SHIM_PROTOCOL_VERSION,
      backend: this.id,
      model: config.model,
      datasetSource: config.datasetSource,
      datasetFormat: expect(normaliseDatasetFormat(config.datasetFormat)),
      train: {
        maxSteps: config.maxSteps ?? null,
        numTrainEpochs: config.numTrainEpochs ?? null,
        batchSize: config.batchSize ?? null,
        learningRate: config.learningRate ?? null,
        maxSeqLength: config.maxLength ?? null,
        loraR: config.loraR ?? null,
        loraAlpha: config.loraAlpha ?? null,
        optimizer: optim.value,
        lrSchedule: expect(normaliseLrSchedule(config.lrSchedulerType)),
        weightDecay: config.weightDecay ?? null,
        warmupSteps: expect(normaliseWarmupSteps(config.warmupSteps)),
        // `{ratio}` shapes resolve inside the shim: epoch-based runs only
        // learn their total iteration count after the dataset is sized.
        loggingSteps: expect(
          normaliseSteps("loggingSteps", config.loggingSteps),
        ),
        saveSteps: expect(normaliseSteps("saveSteps", config.saveSteps)),
        evalSteps: expect(normaliseSteps("evalSteps", config.evalSteps)),
        maskPrompt: expect(
          normaliseTrainOnResponsesOnly(config.trainOnResponsesOnly),
        ),
        datasetSplit: expect(normaliseDatasetSplit(config.datasetSplit)),
        dryRun: config.dryRun ?? false,
      },
      paths: {
        adaptersDir: paths.adaptersDir,
        dataDir: paths.dataDir,
      },
      warnings,
    };

    return {
      spec: {
        command: "uv",
        // `--no-project` keeps uv from adopting a pyproject.toml in the
        // user's repo: the training environment must be exactly the pinned
        // spec, not the user's unrelated Python project.
        argv: [
          "run",
          "--no-project",
          "--with",
          MLX_LM_SPEC,
          "python",
          join(paths.shimDir, "mlx", "train_shim.py"),
          "--run",
          paths.runJsonPath,
        ],
      },
      runJson,
      warnings,
    };
  },

  inference: {
    buildServerSpec({ model, adapterPath, host, port }) {
      const argv = [
        "run",
        "--no-project",
        "--with",
        MLX_LM_SPEC,
        "python",
        "-m",
        "mlx_lm",
        "server",
        "--host",
        host,
        "--port",
        String(port),
        "--model",
        model,
      ];
      if (adapterPath !== null) argv.push("--adapter-path", adapterPath);
      return { command: "uv", argv };
    },
  },
};

/** Unwrap a normaliser result that validateConfig already proved valid. */
function expect<T>(value: T | Error): T {
  if (value instanceof Error) throw value;
  return value;
}

/**
 * Validate the dataset-source union. The HTTP envelope deliberately accepts
 * any `type` string and defers to the backend, so a malformed source must
 * be rejected here, before a job record is created and a uv child spawns.
 */
function validateDatasetSource(value: unknown): true | Error {
  if (typeof value !== "object" || value === null) {
    return new Error("datasetSource must be an object");
  }
  const source = value as { type?: unknown; name?: unknown; url?: unknown };
  if (source.type === "huggingface") {
    if (typeof source.name !== "string" || source.name.length === 0) {
      return new Error(
        "datasetSource.name (the HuggingFace dataset id) is required",
      );
    }
    return true;
  }
  if (source.type === "blob") {
    if (typeof source.url !== "string" || source.url.length === 0) {
      return new Error("datasetSource.url is required for blob datasets");
    }
    let parsed: URL;
    try {
      parsed = new URL(source.url);
    } catch {
      return new Error(`datasetSource.url is not a valid URL: ${source.url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Error(
        `datasetSource.url must be http(s), got ${parsed.protocol}//`,
      );
    }
    return true;
  }
  return new Error(
    `datasetSource.type must be "huggingface" or "blob", got ${JSON.stringify(source.type)}`,
  );
}

function normaliseDatasetFormat(
  value: unknown,
): NormalisedDatasetFormat | Error {
  if (value === undefined) return { type: "chatml" };
  let raw: { type?: unknown; columnMapping?: unknown } | null = null;
  if (typeof value === "string") {
    raw = { type: value };
  } else if (typeof value === "object" && value !== null) {
    raw = value as { type?: unknown; columnMapping?: unknown };
  }
  if (!raw || typeof raw.type !== "string") {
    return new Error(
      "datasetFormat must be a format name or an object with a `type` field",
    );
  }
  if (raw.type === "pretokenized") {
    return new Error(
      'datasetFormat "pretokenized" is not supported by the MLX backend',
    );
  }
  if (!(DATASET_FORMATS as readonly string[]).includes(raw.type)) {
    return new Error(
      `datasetFormat "${raw.type}" is not supported by the MLX backend ` +
        `(supported: ${DATASET_FORMATS.join(", ")})`,
    );
  }
  const columnMapping = normaliseColumnMapping(raw.columnMapping);
  if (columnMapping instanceof Error) return columnMapping;
  return {
    type: raw.type as NormalisedDatasetFormat["type"],
    ...(columnMapping ? { columnMapping } : {}),
  };
}

function normaliseColumnMapping(
  value: unknown,
): Record<string, string> | undefined | Error {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("datasetFormat.columnMapping must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const mapping: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (typeof v !== "string") {
      return new Error(
        `datasetFormat.columnMapping.${key} must be a column name string`,
      );
    }
    mapping[key] = v;
  }
  return mapping;
}

function normaliseOptimizer(
  value: string | undefined,
): { value: string; aliased: boolean } | Error {
  if (value === undefined) return { value: "adamw", aliased: false };
  const direct = OPTIMIZERS[value];
  if (direct) return { value: direct, aliased: false };
  if (ADAMW_ALIAS_PATTERN.test(value)) return { value: "adamw", aliased: true };
  return new Error(
    `optim "${value}" is not supported by the MLX backend ` +
      `(supported: ${Object.keys(OPTIMIZERS).join(", ")})`,
  );
}

function normaliseLrSchedule(value: string | undefined): string | Error {
  if (value === undefined) return "constant";
  if ((LR_SCHEDULES as readonly string[]).includes(value)) return value;
  return new Error(
    `lrSchedulerType "${value}" is not supported by the MLX backend ` +
      `(supported: ${LR_SCHEDULES.join(", ")})`,
  );
}

function normaliseWarmupSteps(value: unknown): number | null | Error {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return new Error("warmupSteps must be a non-negative integer");
}

function normaliseSteps(
  field: string,
  value: unknown,
): NormalisedSteps | null | Error {
  if (value === undefined) return null;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value > 0) return { steps: value };
    return new Error(`${field} must be a positive integer`);
  }
  if (typeof value === "object" && value !== null) {
    const { steps, ratio } = value as { steps?: unknown; ratio?: unknown };
    if (steps !== undefined) {
      if (typeof steps === "number" && Number.isInteger(steps) && steps > 0) {
        return { steps };
      }
      return new Error(`${field}.steps must be a positive integer`);
    }
    if (ratio !== undefined) {
      if (typeof ratio === "number" && ratio > 0 && ratio <= 1) {
        return { ratio };
      }
      return new Error(`${field}.ratio must be a number in (0, 1]`);
    }
    return new Error(`${field} must carry either \`steps\` or \`ratio\``);
  }
  return new Error(
    `${field} must be a positive integer or a {steps} / {ratio} object`,
  );
}

function normaliseDatasetSplit(
  value: unknown,
):
  | { enabled: boolean | null; testSize: number | null; seed: number | null }
  | Error {
  if (value === undefined) {
    // `enabled: null` (NOT false) so the shim can tell "the user said
    // nothing" from an explicit `{ enabled: false }` opt-out: omission
    // keeps the shim's automatic 10% validation holdout, false disables
    // it. Collapsing both to false would silently kill eval for every
    // default-config run.
    return { enabled: null, testSize: null, seed: null };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error(
      "datasetSplit must be an object like { enabled, testSize, seed }",
    );
  }
  const { enabled, testSize, seed } = value as {
    enabled?: unknown;
    testSize?: unknown;
    seed?: unknown;
  };
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return new Error("datasetSplit.enabled must be a boolean");
  }
  if (
    testSize !== undefined &&
    !(typeof testSize === "number" && testSize > 0 && testSize < 1)
  ) {
    return new Error("datasetSplit.testSize must be a number in (0, 1)");
  }
  if (
    seed !== undefined &&
    !(typeof seed === "number" && Number.isInteger(seed))
  ) {
    return new Error("datasetSplit.seed must be an integer");
  }
  return {
    enabled: enabled ?? testSize !== undefined,
    testSize: (testSize as number | undefined) ?? null,
    seed: (seed as number | undefined) ?? null,
  };
}

function normaliseTrainOnResponsesOnly(value: unknown): boolean | Error {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null) {
    const { enabled } = value as { enabled?: unknown };
    if (enabled === undefined || typeof enabled === "boolean") {
      return enabled ?? true;
    }
  }
  return new Error(
    "trainOnResponsesOnly must be a boolean or an object with `enabled`",
  );
}
