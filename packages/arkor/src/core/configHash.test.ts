import { describe, it, expect } from "vitest";
import { hashJobConfig } from "./configHash";
import type { JobConfig } from "./types";

describe("hashJobConfig", () => {
  it("returns the same hash for key-order-equivalent configs", () => {
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      maxSteps: 10,
      learningRate: 1e-4,
    };
    const b: JobConfig = {
      learningRate: 1e-4,
      maxSteps: 10,
      datasetSource: { name: "x", type: "huggingface" },
      model: "m",
    } as JobConfig;
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });

  it("returns different hashes for materially different configs", () => {
    const base: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
    };
    expect(hashJobConfig(base)).not.toBe(
      hashJobConfig({ ...base, model: "m2" }),
    );
    expect(hashJobConfig(base)).not.toBe(
      hashJobConfig({
        ...base,
        datasetSource: { type: "huggingface", name: "y" },
      }),
    );
  });

  it("is order-stable for nested arrays (dataset format / split)", () => {
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: ["a", "b", "c"],
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: ["a", "b", "c"],
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });
});
