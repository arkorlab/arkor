import { describe, expect, it } from "vitest";

import { SUPPORTED_MODELS } from "./models";

import type { JobConfig, TrainerInput } from "./types";

describe("SUPPORTED_MODELS", () => {
  it("contains at least one entry", () => {
    // The union `SupportedModel` is derived from this array. An empty list
    // would collapse it to `never`, making every `createTrainer` call in the
    // starter templates fail to compile.
    expect(SUPPORTED_MODELS.length).toBeGreaterThan(0);
  });

  it("every entry is a non-empty HuggingFace-shaped identifier", () => {
    // Cloud-api normalises case internally but still rejects malformed ids,
    // so an entry like "" or "gemma 4" would type-check here and 4xx at run
    // time. Mirrors the same guard in @arkor/studio-app's baseModels.test.ts.
    for (const m of SUPPORTED_MODELS) {
      expect(m).toMatch(/^[A-Z0-9][\w./-]*$/i);
    }
  });
});

describe("TrainerInput.model", () => {
  it("accepts a supported model", () => {
    const model: TrainerInput["model"] = SUPPORTED_MODELS[0];
    expect(model).toBe(SUPPORTED_MODELS[0]);
  });

  it("rejects an unsupported model at compile time", () => {
    // The point of the narrowing: a typo used to type-check and only surface
    // as a 4xx once the job ran. If this line ever stops erroring, the field
    // has silently widened back to `string`.
    // @ts-expect-error "gema" is a typo and is not in SUPPORTED_MODELS
    const model: TrainerInput["model"] = "unsloth/gema-4-E4B-it";
    expect(model).toBe("unsloth/gema-4-E4B-it");
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
