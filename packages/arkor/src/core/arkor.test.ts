import { describe, it, expect } from "vitest";
import { createArkor, isArkor } from "./arkor";
import type { Trainer } from "./types";

function fakeTrainer(name = "run"): Trainer {
  return {
    name,
    async start() {
      return { jobId: "j" };
    },
    async wait() {
      return {
        job: {
          id: "j",
          orgId: "o",
          projectId: "p",
          name,
          status: "completed",
          config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
          createdAt: "2026-01-01",
        },
        artifacts: [],
      };
    },
    async cancel() {},
  };
}

describe("createArkor", () => {
  it("returns a frozen manifest with the brand and the trainer", () => {
    const trainer = fakeTrainer();
    const arkor = createArkor({ trainer });

    expect(arkor._kind).toBe("arkor");
    expect(arkor.trainer).toBe(trainer);
    expect(Object.isFrozen(arkor)).toBe(true);
  });

  it("accepts an empty input (no trainer yet)", () => {
    const arkor = createArkor({});
    expect(arkor._kind).toBe("arkor");
    expect(arkor.trainer).toBeUndefined();
  });
});

describe("isArkor", () => {
  it("recognises a manifest produced by createArkor", () => {
    expect(isArkor(createArkor({ trainer: fakeTrainer() }))).toBe(true);
  });

  it("rejects plain objects, trainers, and non-objects", () => {
    expect(isArkor(null)).toBe(false);
    expect(isArkor(undefined)).toBe(false);
    expect(isArkor({})).toBe(false);
    expect(isArkor(fakeTrainer())).toBe(false);
    expect(isArkor({ trainer: fakeTrainer() })).toBe(false);
    expect(isArkor("arkor")).toBe(false);
  });
});
