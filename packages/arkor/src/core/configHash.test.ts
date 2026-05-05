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

  it("treats `undefined` object properties identically to omitted ones (JSON parity)", () => {
    // Regression: the previous `stableStringify` delegated to
    // `JSON.stringify(undefined)` which returns `undefined` (not a
    // string) — concatenated via template literal that became the
    // substring `"undefined"` in the hash input. So `{ a: 1 }` and
    // `{ a: 1, b: undefined }` produced different hashes even though
    // they're indistinguishable on the wire (`JSON.stringify` drops
    // `undefined` properties).
    const omitted: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
    };
    const explicitlyUndefined: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      // `unknown`-typed forwarder fields can legitimately end up
      // holding `undefined` if a caller spreads from a partial source.
      warmupSteps: undefined,
      datasetFormat: undefined,
    };
    expect(hashJobConfig(omitted)).toBe(hashJobConfig(explicitlyUndefined));
  });

  it("normalises `undefined` array slots to null (JSON parity)", () => {
    // `JSON.stringify([undefined])` → `"[null]"`. The previous
    // implementation produced the literal substring `"[undefined]"`
    // instead, which is not even valid JSON.
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: ["a", undefined, "c"] as unknown,
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: ["a", null, "c"] as unknown,
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });

  it("honors `toJSON()` like JSON.stringify (Date, etc.)", () => {
    // Regression: `JSON.stringify({ d: new Date(0) })` serialises
    // `d` as `"1970-01-01T00:00:00.000Z"`, but a naive recursive
    // walker would serialise the Date as `{}` (no enumerable own
    // keys). A `JobConfig` whose `unknown`-typed forwarder field
    // ever holds a Date (or any object with `toJSON`) would then
    // produce a hash that disagrees with the wire-format payload,
    // causing spurious "configHash changed" → SIGTERM restarts.
    const date = new Date("2024-01-01T00:00:00.000Z");
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: date as unknown,
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: "2024-01-01T00:00:00.000Z" as unknown,
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });

  it("ignores function / symbol properties (JSON parity)", () => {
    // `JSON.stringify` drops these too. The hash should be insensitive
    // to "transparent" callbacks accidentally landing in a forwarded
    // config (the SDK separates `callbacks` out, but `unknown` fields
    // could leak one).
    const fn = () => 0;
    const sym = Symbol("foo");
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: fn as unknown,
      loggingSteps: sym as unknown,
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });
});
