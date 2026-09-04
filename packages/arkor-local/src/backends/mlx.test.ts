import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MLX_LM_SPEC, mlxBackend } from "./mlx";

import type { JobConfig } from "arkor";
import type { ExecProbe, TrainRunPaths } from "./types";

const okProbe: ExecProbe = () =>
  Promise.resolve({ ok: true, stdout: "uv 0.9.0" });
const failProbe: ExecProbe = () =>
  Promise.resolve({ ok: false, stdout: "", error: "spawn uv ENOENT" });

function baseConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    model: "mlx-community/tiny-test-model",
    datasetSource: { type: "huggingface", name: "org/data" },
    maxSteps: 100,
    ...overrides,
  };
}

const PATHS: TrainRunPaths = {
  jobDir: "/tmp/jobs/j1",
  runJsonPath: "/tmp/jobs/j1/run.json",
  adaptersDir: "/tmp/jobs/j1/adapters",
  dataDir: "/tmp/jobs/j1/data",
  shimDir: "/pkg/dist/shims",
};

describe("mlxBackend.preflight", () => {
  it("passes on darwin/arm64 with uv available", async () => {
    await expect(
      mlxBackend.preflight({
        platform: "darwin",
        arch: "arm64",
        execProbe: okProbe,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it.each([
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
    ["darwin", "x64"], // Intel Mac: MLX has no support upstream
  ] as const)("fails on %s/%s before probing uv", async (platform, arch) => {
    let probed = false;
    const probe: ExecProbe = () => {
      probed = true;
      return Promise.resolve({ ok: true, stdout: "" });
    };
    const result = await mlxBackend.preflight({
      platform,
      arch,
      execProbe: probe,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Apple Silicon");
      expect(result.reason).toContain(`${platform}/${arch}`);
    }
    // The platform gate must short-circuit: probing uv on a machine that can
    // never run MLX would only muddy the error.
    expect(probed).toBe(false);
  });

  it("fails with install guidance when uv is missing", async () => {
    const result = await mlxBackend.preflight({
      platform: "darwin",
      arch: "arm64",
      execProbe: failProbe,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("uv is not available");
      expect(result.remediation).toContain("brew install uv");
      expect(result.remediation).toContain("astral.sh");
    }
  });
});

describe("mlxBackend.validateConfig", () => {
  it("accepts a template-shaped config", () => {
    expect(
      mlxBackend.validateConfig(
        baseConfig({
          datasetFormat: { type: "chatml" },
          loraR: 16,
          loraAlpha: 16,
          loadIn4bit: false,
          evalSteps: 25,
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("requires maxSteps or numTrainEpochs", () => {
    const result = mlxBackend.validateConfig(
      baseConfig({ maxSteps: undefined }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("maxSteps or numTrainEpochs");
    }
    expect(
      mlxBackend.validateConfig(
        baseConfig({ maxSteps: undefined, numTrainEpochs: 2 }),
      ),
    ).toEqual({ ok: true });
  });

  it("rejects pretokenized and unknown dataset formats", () => {
    const pretokenized = mlxBackend.validateConfig(
      baseConfig({ datasetFormat: { type: "pretokenized" } }),
    );
    expect(pretokenized).toMatchObject({ ok: false });
    if (!pretokenized.ok) {
      expect(pretokenized.errors[0]).toContain("pretokenized");
    }
    expect(
      mlxBackend.validateConfig(baseConfig({ datasetFormat: "nonsense" })),
    ).toMatchObject({ ok: false });
  });

  it("accepts blob dataset sources", () => {
    // The shim downloads blobs itself; rejecting them here would regress the
    // cloud-parity goal.
    expect(
      mlxBackend.validateConfig(
        baseConfig({
          datasetSource: { type: "blob", url: "https://example.com/d.jsonl" },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("collects one error per invalid field", () => {
    const result = mlxBackend.validateConfig(
      baseConfig({
        maxSteps: undefined,
        optim: "lion",
        lrSchedulerType: "polynomial",
        weightDecay: -1,
        loggingSteps: { ratio: 4 },
      }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors).toHaveLength(5);
      expect(result.errors.join("\n")).toContain('optim "lion"');
      expect(result.errors.join("\n")).toContain(
        'lrSchedulerType "polynomial"',
      );
      expect(result.errors.join("\n")).toContain("weightDecay");
      expect(result.errors.join("\n")).toContain("loggingSteps.ratio");
    }
  });

  it("rejects non-numeric and non-positive training numbers", () => {
    const result = mlxBackend.validateConfig(
      baseConfig({
        maxSteps: 0,
        batchSize: -1,
        loraR: 0,
      }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("maxSteps");
      expect(result.errors.join("\n")).toContain("batchSize");
      expect(result.errors.join("\n")).toContain("loraR");
    }
  });

  it("rejects non-boolean dryRun and loadIn4bit values", () => {
    // A JS caller can pass an env-derived string; "false" must not become
    // truthy in the shim (which would skip training yet report completed).
    const result = mlxBackend.validateConfig(
      baseConfig({
        dryRun: "false" as unknown as boolean,
        loadIn4bit: "yes" as unknown as boolean,
      }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("dryRun must be a boolean");
      expect(result.errors.join("\n")).toContain(
        "loadIn4bit must be a boolean",
      );
    }
  });

  it("rejects prototype keys and unknown column mappings", () => {
    // A plain-object lookup would resolve Object.prototype members, so a
    // JS caller could smuggle optim: "constructor" past validation.
    const proto = mlxBackend.validateConfig(
      baseConfig({ optim: "constructor" as unknown as string }),
    );
    expect(proto).toMatchObject({ ok: false });
    if (!proto.ok) {
      expect(proto.errors.join("\n")).toContain('optim "constructor"');
    }
    // A typo'd mapping key would otherwise be dropped by the shim, which
    // then trains on whatever the default column happens to hold.
    const typo = mlxBackend.validateConfig(
      baseConfig({
        datasetFormat: {
          type: "prompt_completion",
          columnMapping: { promt: "question", completion: "answer" },
        } as never,
      }),
    );
    expect(typo).toMatchObject({ ok: false });
    if (!typo.ok) {
      expect(typo.errors.join("\n")).toContain("columnMapping.promt");
      expect(typo.errors.join("\n")).toContain("prompt, completion");
    }
    // The format's own keys still pass.
    expect(
      mlxBackend.validateConfig(
        baseConfig({
          datasetFormat: {
            type: "alpaca",
            columnMapping: { instruction: "q", output: "a" },
          } as never,
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("treats null like absent and rejects misspelt config keys", () => {
    // Configs arrive as parsed JSON, where an unset optional field is
    // often serialised as null; rejecting it would 400 an otherwise valid
    // run whose omitted-field twin succeeds.
    expect(
      mlxBackend.validateConfig(
        baseConfig({
          datasetSplit: null as never,
          warmupSteps: null as never,
          weightDecay: null as never,
          optim: null as never,
          trainOnResponsesOnly: null as never,
        }),
      ),
    ).toEqual({ ok: true });

    // Typos in these `unknown`-typed objects would otherwise be dropped by
    // destructuring and the run would silently use defaults.
    for (const [config, needle] of [
      [
        baseConfig({ datasetSplit: { testSize: 0.2, sed: 42 } as never }),
        "datasetSplit.sed",
      ],
      [
        baseConfig({
          datasetFormat: {
            type: "prompt_completion",
            columnMappings: { prompt: "q" },
          } as never,
        }),
        "datasetFormat.columnMappings",
      ],
      [
        baseConfig({ trainOnResponsesOnly: { enabld: false } as never }),
        "trainOnResponsesOnly.enabld",
      ],
      [
        baseConfig({
          datasetSource: {
            type: "huggingface",
            name: "org/ds",
            split: 0,
          } as never,
        }),
        "datasetSource.split",
      ],
    ] as const) {
      const result = mlxBackend.validateConfig(config);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.errors.join("\n")).toContain(needle);
    }
  });

  it("rejects unknown fields and malformed shapes across the config", () => {
    // These objects arrive as `unknown`, so a typo is invisible to the
    // compiler and would otherwise be dropped by destructuring: the run
    // would silently train with defaults the caller never asked for.
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          datasetSource: {
            type: "huggingface",
            name: "org/data",
            spllt: "validation",
          },
        },
        "datasetSource.spllt",
      ],
      [
        {
          datasetSource: {
            type: "blob",
            url: "https://example.com/d.jsonl",
            tokn: "x",
          },
        },
        "datasetSource.tokn",
      ],
      [
        {
          datasetSource: {
            type: "blob",
            url: "https://example.com/d.jsonl",
            token: 0 as unknown as string,
          },
        },
        "datasetSource.token must be a non-empty string",
      ],
      [{ datasetSplit: { testSize: 0.2, sed: 42 } }, "datasetSplit.sed"],
      [
        { trainOnResponsesOnly: { enabld: false } },
        "trainOnResponsesOnly.enabld",
      ],
      // An array is an object with no unknown keys, so it would slip
      // through a key-only check and read as "nothing configured".
      [{ loggingSteps: [] }, "loggingSteps"],
      [{ evalSteps: { stps: 5 } }, "evalSteps.stps"],
    ];
    for (const [overrides, expected] of cases) {
      const result = mlxBackend.validateConfig(
        baseConfig(overrides as Parameters<typeof baseConfig>[0]),
      );
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.errors.join("\n")).toContain(expected);
    }
  });

  it("accepts supported optimizers, schedules, and step shapes", () => {
    expect(
      mlxBackend.validateConfig(
        baseConfig({
          optim: "adamw",
          lrSchedulerType: "cosine",
          weightDecay: 0.01,
          warmupSteps: 10,
          loggingSteps: 5,
          saveSteps: { steps: 50 },
          evalSteps: { ratio: 0.25 },
          trainOnResponsesOnly: { enabled: true },
          datasetSplit: { testSize: 0.1, seed: 42 },
        }),
      ),
    ).toEqual({ ok: true });
  });
});

describe("mlxBackend.buildTrainRun", () => {
  it("builds the uv invocation around the bundled shim", () => {
    const run = mlxBackend.buildTrainRun({
      config: baseConfig(),
      paths: PATHS,
    });
    expect(run.spec.command).toBe("uv");
    expect(run.spec.argv).toEqual([
      "run",
      // Both isolation flags: --no-project skips the user's workspace,
      // --no-config their uv.toml / [tool.uv] settings.
      "--no-project",
      "--no-config",
      "--with",
      MLX_LM_SPEC,
      "python",
      // Built with join(): backslash-separated on Windows.
      join(PATHS.shimDir, "mlx", "train_shim.py"),
      "--run",
      "/tmp/jobs/j1/run.json",
    ]);
  });

  it("writes a complete run.json payload with normalised fields", () => {
    const run = mlxBackend.buildTrainRun({
      config: baseConfig({
        datasetFormat: {
          type: "prompt_completion",
          columnMapping: { prompt: "q", completion: "a" },
        },
        batchSize: 2,
        learningRate: 1e-5,
        maxLength: 1024,
        loraR: 8,
        loraAlpha: 16,
        optim: "adamw_8bit",
        lrSchedulerType: "linear",
        weightDecay: 0.01,
        warmupSteps: 5,
        loggingSteps: 1,
        saveSteps: { ratio: 0.5 },
        evalSteps: { steps: 10 },
        trainOnResponsesOnly: true,
        datasetSplit: { testSize: 0.2 },
        dryRun: false,
      }),
      paths: PATHS,
    });
    expect(run.runJson).toMatchObject({
      protocolVersion: 1,
      backend: "mlx",
      model: "mlx-community/tiny-test-model",
      datasetSource: { type: "huggingface", name: "org/data" },
      datasetFormat: {
        type: "prompt_completion",
        columnMapping: { prompt: "q", completion: "a" },
      },
      train: {
        maxSteps: 100,
        numTrainEpochs: null,
        batchSize: 2,
        learningRate: 1e-5,
        maxSeqLength: 1024,
        loraR: 8,
        loraAlpha: 16,
        optimizer: "adamw",
        lrSchedule: "linear",
        weightDecay: 0.01,
        warmupSteps: 5,
        loggingSteps: { steps: 1 },
        saveSteps: { ratio: 0.5 },
        evalSteps: { steps: 10 },
        maskPrompt: true,
        datasetSplit: { enabled: true, testSize: 0.2, seed: null },
        dryRun: false,
      },
      paths: {
        adaptersDir: "/tmp/jobs/j1/adapters",
        dataDir: "/tmp/jobs/j1/data",
      },
    });
    // The 8-bit alias degraded to plain adamw and said so.
    expect(run.warnings.join("\n")).toContain('optim "adamw_8bit"');
  });

  it("keeps an omitted datasetSplit distinct from an explicit opt-out", () => {
    // `enabled: null` tells the shim "the user said nothing", which keeps
    // its automatic 10% validation holdout; an explicit false disables it.
    const omitted = mlxBackend.buildTrainRun({
      config: baseConfig(),
      paths: PATHS,
    });
    expect(
      (omitted.runJson.train as Record<string, unknown>).datasetSplit,
    ).toEqual({ enabled: null, testSize: null, seed: null });
    const optOut = mlxBackend.buildTrainRun({
      config: baseConfig({ datasetSplit: { enabled: false } }),
      paths: PATHS,
    });
    expect(
      (optOut.runJson.train as Record<string, unknown>).datasetSplit,
    ).toEqual({ enabled: false, testSize: null, seed: null });
    // A bare `{}` says nothing: same as omission, NOT an opt-out.
    const empty = mlxBackend.buildTrainRun({
      config: baseConfig({ datasetSplit: {} }),
      paths: PATHS,
    });
    expect(
      (empty.runJson.train as Record<string, unknown>).datasetSplit,
    ).toEqual({ enabled: null, testSize: null, seed: null });
    // A lone seed implies an intentional split; the auto path would
    // silently ignore it (it uses a fixed seed).
    const seedOnly = mlxBackend.buildTrainRun({
      config: baseConfig({ datasetSplit: { seed: 7 } }),
      paths: PATHS,
    });
    expect(
      (seedOnly.runJson.train as Record<string, unknown>).datasetSplit,
    ).toEqual({ enabled: true, testSize: null, seed: 7 });
  });

  it("defaults optimizer, schedule, and dataset format when unset", () => {
    const run = mlxBackend.buildTrainRun({
      config: baseConfig(),
      paths: PATHS,
    });
    expect(run.runJson).toMatchObject({
      datasetFormat: { type: "chatml" },
      train: {
        optimizer: "adamw",
        lrSchedule: "constant",
        maskPrompt: false,
        dryRun: false,
      },
    });
    expect(run.warnings).toEqual([]);
  });

  it("warns about loadIn4bit instead of failing", () => {
    const run = mlxBackend.buildTrainRun({
      config: baseConfig({ loadIn4bit: true }),
      paths: PATHS,
    });
    expect(run.warnings.join("\n")).toContain("loadIn4bit");
    expect(run.warnings.join("\n")).toContain("mlx-community");
  });

  it("throws when handed a config validateConfig would reject", () => {
    expect(() =>
      mlxBackend.buildTrainRun({
        config: baseConfig({ optim: "lion" }),
        paths: PATHS,
      }),
    ).toThrow(/invalid config/);
  });
});

describe("mlxBackend.inference", () => {
  it("builds an OpenAI-compatible server invocation", () => {
    const spec = mlxBackend.inference?.buildServerSpec({
      model: "mlx-community/tiny-test-model",
      adapterPath: "/jobs/j1/adapters/final",
      host: "127.0.0.1",
      port: 12_345,
      shimDir: "/pkg/dist/shims",
    });
    expect(spec).toEqual({
      command: "uv",
      argv: [
        "run",
        "--no-project",
        "--no-config",
        "--with",
        MLX_LM_SPEC,
        "python",
        "-m",
        "mlx_lm",
        "server",
        "--host",
        "127.0.0.1",
        "--port",
        "12345",
        "--model",
        "mlx-community/tiny-test-model",
        "--adapter-path",
        "/jobs/j1/adapters/final",
      ],
    });
  });

  it("omits the adapter flag for base-model serving", () => {
    const spec = mlxBackend.inference?.buildServerSpec({
      model: "mlx-community/tiny-test-model",
      adapterPath: null,
      host: "127.0.0.1",
      port: 12_345,
      shimDir: "/pkg/dist/shims",
    });
    expect(spec?.argv).not.toContain("--adapter-path");
  });
});
