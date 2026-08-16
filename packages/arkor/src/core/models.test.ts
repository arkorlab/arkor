import { describe, expect, it } from "vitest";

import { isSupportedModel, SUPPORTED_MODELS } from "./models";
import { createTrainer } from "./trainer";

import type { JobConfig } from "./types";

type CreateTrainerInput = Parameters<typeof createTrainer>[0];

describe("SUPPORTED_MODELS", () => {
  it("contains at least one entry", () => {
    // The union `SupportedModel` is derived from this array. An empty list
    // would collapse it to `never`, making every `createTrainer` call in the
    // starter templates fail to compile.
    expect(SUPPORTED_MODELS.length).toBeGreaterThan(0);
  });

  it("is frozen", () => {
    // `as const` is erased at run time, and `createTrainer`'s runtime guard
    // checks against this array. Without the freeze, a plain-JavaScript
    // consumer (the very context the guard protects) could push into the
    // list and defeat it.
    expect(Object.isFrozen(SUPPORTED_MODELS)).toBe(true);
  });

  it("isSupportedModel matches exactly the SUPPORTED_MODELS entries", () => {
    // The guard exists because `TrainerInput.model` admits arbitrary strings
    // (local mode); it must stay a faithful membership test.
    for (const m of SUPPORTED_MODELS) {
      expect(isSupportedModel(m)).toBe(true);
    }
    expect(isSupportedModel("mlx-community/some-local-model")).toBe(false);
    expect(isSupportedModel("")).toBe(false);
  });

  it("every entry is an owner/model shaped HuggingFace identifier", () => {
    // Cloud-api normalises case internally but still rejects malformed ids,
    // so an entry like "" or a bare "gemma-4" (no owner namespace) would
    // type-check here and 4xx at run time. Deliberately stricter than the
    // similar guard in @arkor/studio-app's baseModels.test.ts: this one
    // requires the owner/model shape.
    for (const m of SUPPORTED_MODELS) {
      expect(m).toMatch(/^[\w-]+\/[\w.-]+$/);
    }
  });
});

describe("createTrainer model boundary", () => {
  it("accepts a supported model", () => {
    // Asserted through the public `createTrainer` parameter type rather than
    // `TrainerInput` so a regression in the export surface is caught too.
    const model: CreateTrainerInput["model"] = SUPPORTED_MODELS[0];
    expect(model).toBe(SUPPORTED_MODELS[0]);
  });

  it("accepts an arbitrary model id at compile time", () => {
    // Deliberately widened for local mode (`arkor start --local`): the local
    // backend takes any HuggingFace id, so the field admits free-form
    // strings while `SupportedModel` literals keep driving autocompletion.
    // The cloud-side gate moved entirely to the runtime guard below.
    const model: CreateTrainerInput["model"] = "mlx-community/some-local-model";
    expect(model).toBe("mlx-community/some-local-model");
  });

  it("rejects an unsupported model at run time outside local mode", () => {
    // The CLI path (`arkor build` / `arkor start`) bundles with esbuild and
    // never typechecks, and the compile-time type admits arbitrary strings
    // for local mode. The constructor guard is what stops a typo from
    // reaching cloud job creation.
    expect(() =>
      createTrainer({
        name: "run",
        model: "unsloth/gema-4-E4B-it",
        dataset: { type: "huggingface", name: "x" },
      }),
    ).toThrow(/Unsupported model/);
  });
});

describe("JobConfig.model", () => {
  it("stays assignable from an arbitrary string", () => {
    // Deliberately NOT narrowed. `JobConfig` doubles as the decoded shape of
    // a job coming back from the server (`TrainingJob.config`), and the
    // backend is free to run a model this SDK version predates: the roadmap
    // plans exactly that widening. Narrowing here would make the type lie
    // about server data, and `trainingJobSchema` would keep parsing it, so
    // the lie would be unsound rather than merely imprecise.
    const config: JobConfig = {
      model: "some/model-this-sdk-has-never-heard-of",
      datasetSource: { type: "huggingface", name: "x" },
    };
    expect(config.model).toBe("some/model-this-sdk-has-never-heard-of");
  });
});
