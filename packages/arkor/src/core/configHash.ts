import { createHash } from "node:crypto";
import type { JobConfig } from "./types";

/**
 * Type-narrowing helper for "this value cannot be represented in JSON".
 * Mirrors the cases JSON.stringify silently drops (when in object
 * positions) or coerces to `null` (when in array positions): `undefined`,
 * functions, and symbols.
 */
function isNonJsonRepresentable(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

/**
 * Deterministic JSON serialiser: keys sorted at every nesting level so
 * `{a:1, b:2}` and `{b:2, a:1}` produce the same string. Necessary because
 * `JSON.stringify` follows insertion order, which isn't stable across
 * `buildJobConfig` revisions or user-side spread-merge tricks.
 *
 * Mirrors the JSON wire-format exactly for non-representable values
 * (`undefined`, functions, symbols): omitted in object positions,
 * serialised as `null` in array positions. The previous implementation
 * delegated to `JSON.stringify` which returns the literal value
 * `undefined` (not a string) for those — concatenated into the output
 * via template literals it became the substring `"undefined"`, which
 * is not valid JSON and would silently change the hash if a
 * `JobConfig` field ever held one of those values (notably the
 * `unknown`-typed forwarder fields).
 */
function stableStringify(value: unknown, key: string = ""): string {
  if (value === null) return "null";
  // Top-level non-representable: align with `JSON.stringify(undefined)`
  // semantics by collapsing to "null" so the hash input stays valid
  // JSON-shaped text rather than the literal substring "undefined".
  if (isNonJsonRepresentable(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  // `JSON.stringify` calls `value.toJSON(key)` first when present
  // (passing `""` at the top level, the property name in object
  // positions, the index-as-string in array positions), then
  // serialises the return value. The canonical example is `Date`,
  // which becomes its ISO string. Without this branch a `Date`
  // would hash as `{}` (no enumerable keys) and a `JobConfig` whose
  // `unknown`-typed forwarder field happened to hold one would
  // diverge from the wire-format payload — leading to bogus
  // configHash drift and unnecessary SIGTERM restarts on every
  // rebuild. The `key` argument is threaded through recursion so
  // user-side `toJSON(key)` implementations that branch on the
  // hosting property/index see the same value JSON.stringify would
  // give them.
  const maybeToJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof maybeToJSON === "function") {
    return stableStringify(
      (maybeToJSON as (key: string) => unknown).call(value, key),
      key,
    );
  }
  if (Array.isArray(value)) {
    // Array slots: non-representable → "null" (matches JSON spec).
    // Index-as-string keys mirror `JSON.stringify`'s behaviour for
    // array elements (per the ECMAScript spec, `SerializeJSONArray`
    // calls `SerializeJSONProperty` with the index converted to a
    // string).
    const items = value.map((v, i) =>
      isNonJsonRepresentable(v) ? "null" : stableStringify(v, String(i)),
    );
    return `[${items.join(",")}]`;
  }
  // Object slots: drop non-representable values entirely (matches
  // `JSON.stringify({a: undefined}) === "{}"`). Property names are
  // passed as the recursion key so a nested `toJSON(key)` sees the
  // hosting field name.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => !isNonJsonRepresentable(obj[k]))
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k], k)}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Stable fingerprint of a `JobConfig`. Used by HMR to decide whether a
 * rebuild changed only the in-process callbacks (configHash unchanged →
 * hot-swap) or the cloud-side training config (configHash changed →
 * full restart with `requestEarlyStop`).
 */
export function hashJobConfig(config: JobConfig): string {
  return createHash("sha256")
    .update(stableStringify(config))
    .digest("hex")
    .slice(0, 16);
}
