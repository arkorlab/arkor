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
    // string), concatenated via template literal that became the
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

  it("threads the property key through to user-defined `toJSON(key)` (JSON parity)", () => {
    // Regression: `JSON.stringify` calls `value.toJSON(key)` with
    // the hosting property name (or array index as string), so a
    // `toJSON` that branches on the key produces different output
    // depending on where the value lives in the tree. The previous
    // `stableStringify` called `toJSON()` without the key argument,
    // so the hash diverged from the wire-format payload for any
    // user object whose serialiser depends on context.
    //
    // The fixture's `toJSON(key)` returns `"key=<key>"`. Compare
    // against an explicit string field holding what JSON.stringify
    // would produce; matching hashes prove the key reached toJSON.
    const ctx = {
      toJSON(key: string) {
        return `key=${key}`;
      },
    };
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: ctx as unknown,
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: "key=warmupSteps" as unknown,
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });

  it("omits an object property whose `toJSON(key)` returns undefined (JSON parity)", () => {
    // Regression: `JSON.stringify({ a: { toJSON: () => undefined } })`
    // produces `"{}"`: `toJSON` returning `undefined` is the spec's
    // "skip me" signal in object position. The previous
    // `stableStringify` collapsed every non-representable value to
    // the literal string `"null"` at recursion time, so the same
    // input hashed as `{"a":null}` instead of `{}`. That divergence
    // forced unnecessary SIGTERM restarts whenever a `JobConfig`
    // field's serialiser opted out: `configHash` would diverge from
    // the wire-format payload (which DOES omit the field).
    const omitting = {
      toJSON() {
        return undefined;
      },
    };
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: omitting as unknown,
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });

  it("substitutes `null` for an array element whose `toJSON(idx)` returns undefined (JSON parity)", () => {
    // Sibling contract: in array position, `JSON.stringify` writes
    // `null` for a `toJSON()→undefined` element (it can't drop the
    // slot without shifting indices). The `stableStringify` boundary
    // for arrays maps the omit sentinel to `"null"`.
    const omitting = {
      toJSON() {
        return undefined;
      },
    };
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: ["a", omitting, "c"] as unknown,
    };
    const b: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: ["a", null, "c"] as unknown,
    };
    expect(hashJobConfig(a)).toBe(hashJobConfig(b));
  });

  it("throws a clear TypeError on circular structures (JSON parity, no stack overflow)", () => {
    // Regression: the recursive `stableStringify` previously had no
    // cycle detection. A `JobConfig` with a circular reference inside
    // any `unknown` field (easy to do accidentally, e.g. a logger
    // helper that back-references its own context) would recurse
    // until the call stack overflowed and took the HMR / build path
    // down with it. `JSON.stringify` itself throws a `TypeError`
    // ("Converting circular structure to JSON") for the same input;
    // mirror that shape so callers get a useful error message instead
    // of a fatal `RangeError: Maximum call stack size exceeded`.
    const self: Record<string, unknown> = {};
    self.self = self; // direct cycle
    const config: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: self as unknown,
    };
    expect(() => hashJobConfig(config)).toThrow(TypeError);
    expect(() => hashJobConfig(config)).toThrow(/circular/i);

    // Indirect cycle (A → B → A) is rejected too: the WeakSet tracks
    // every object currently on the recursion stack, not just direct
    // self-references.
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    const indirect: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: a as unknown,
    };
    expect(() => hashJobConfig(indirect)).toThrow(TypeError);
  });

  it("detects a cycle when `toJSON()` returns the object itself (JSON.stringify parity)", () => {
    // CodeRabbit regression: `toJSON` used to be invoked BEFORE the
    // current object was inserted into `seen`. A
    // `{ toJSON() { return this; } }` would then loop forever (each
    // recursive call re-checked toJSON before the cycle gate could
    // see the previous frame), crashing with `RangeError: Maximum
    // call stack size exceeded` rather than the cycle-shaped
    // `TypeError` `JSON.stringify` produces for the same input. The
    // fix moves the `seen.add(value)` ahead of the toJSON invocation
    // so the cycle is caught on the very first recursive re-entry.
    const selfReturning = {
      toJSON(): unknown {
        return this;
      },
    };
    const config: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      warmupSteps: selfReturning as unknown,
    };
    expect(() => hashJobConfig(config)).toThrow(TypeError);
    expect(() => hashJobConfig(config)).toThrow(/circular/i);
  });

  it("substitutes `null` for sparse array holes (JSON.stringify parity)", () => {
    // CodeRabbit regression: `Array.prototype.map` skips sparse
    // holes and leaves them as holes in the result array;
    // `[items...].join(",")` then renders the holes as empty
    // strings, producing the invalid `[,1]` instead of the
    // JSON-spec `[null,1]`. The indexed `for` loop reads each slot
    // via `value[i]` (which returns `undefined` for holes),
    // recurses to `undefined`, and the `?? "null"` fallback emits
    // the spec-correct substitution.
    const sparse = [] as unknown[];
    sparse[2] = "x"; // creates holes at indices 0 and 1
    const a: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: sparse as unknown,
    };
    const dense: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      datasetFormat: [null, null, "x"] as unknown,
    };
    // Hash equality proves the hole positions were emitted as the
    // string `"null"` (matching `JSON.stringify`), not skipped.
    expect(hashJobConfig(a)).toBe(hashJobConfig(dense));
  });

  it("permits a shared (non-cyclic) reference reused across sibling slots", () => {
    // Defensive companion to the cycle test: a value appearing twice
    // as a *sibling* (not as an ancestor) is legitimate JSON, not a
    // cycle. The recursion drops each node from `seen` on the way out
    // via the `finally` block so sibling re-use doesn't false-positive
    // as a cycle.
    const shared = { kind: "openai", name: "gpt-4o-mini" };
    const config: JobConfig = {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
      // Array with the same object reference in two positions.
      datasetFormat: [shared, shared] as unknown,
    };
    expect(() => hashJobConfig(config)).not.toThrow();
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
