import { createHash } from "node:crypto";

import type { JobConfig } from "./types";

/**
 * Deterministic JSON serialiser: keys sorted at every nesting level so
 * `{a:1, b:2}` and `{b:2, a:1}` produce the same string. Necessary because
 * `JSON.stringify` follows insertion order, which isn't stable across
 * `buildJobConfig` revisions or user-side spread-merge tricks.
 *
 * Returns `string | undefined`. `undefined` is the "omit me from my
 * containing object" sentinel: it propagates from any value
 * `JSON.stringify` would silently drop in object position
 * (`undefined`, functions, symbols, *and* objects whose `toJSON(key)`
 * returns one of those). Callers sit at three boundaries:
 *
 *   - Top level: `hashJobConfig` collapses `undefined` to `"null"`
 *     so the digest input stays a valid hash string.
 *   - Array slots: the map below substitutes `"null"` (matches
 *     `JSON.stringify([undefined]) === "[null]"`).
 *   - Object slots: the loop filters the key out entirely (matches
 *     `JSON.stringify({a: undefined}) === "{}"`).
 *
 * The previous implementation collapsed every non-representable to
 * the literal string `"null"` at recursion time, which leaked into
 * object slots as `{"a":null}` instead of the JSON-correct `{}`,
 * making `configHash` diverge from the wire-format payload for
 * `JobConfig` fields whose `toJSON(key)` happened to return
 * `undefined` (the spec-defined "skip me" signal). That divergence
 * forces unnecessary SIGTERM restarts on every rebuild.
 */
function stableStringifyRec(
  value: unknown,
  key: string,
  // Tracks every object/array currently on the recursion stack so a
  // user-supplied circular `JobConfig` field surfaces as a clear
  // `TypeError` ("Converting circular structure to JSON") instead of
  // recursing until the call stack overflows and takes the HMR path
  // down with it. Mirrors what `JSON.stringify` would do for the same
  // input. Primitives can never form cycles, so we only insert and
  // check inside the object/array branches below.
  seen: WeakSet<object>,
): string | undefined {
  if (value === null) return "null";
  // Non-representable values: omit (undefined return) so each caller's
  // boundary handler chooses the right substitution per its position.
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (typeof value !== "object") return JSON.stringify(value);
  // Add to `seen` BEFORE the `toJSON` invocation below so a
  // pathological `{ toJSON() { return this; } }` surfaces as a
  // cycle-shaped `TypeError` instead of recursing until the call
  // stack overflows. This is a DELIBERATE divergence from
  // `JSON.stringify`, which serialises the toJSON return value
  // without re-invoking toJSON on it and therefore quietly yields
  // `"{}"` for the same input (verified: `JSON.stringify({toJSON(){
  // return this}}) === "{}"`). Our recursion re-enters the full
  // pipeline (toJSON included) on the returned value, so without
  // this guard the self-returning case would loop forever; throwing
  // is the fail-safe choice for a hash input this pathological
  // (upstream treats the throw as "config not diffable" and routes
  // HMR through the conservative SIGTERM-restart path). The insert
  // happens now, with both the toJSON call and the array/object
  // branches inside the same try/finally, so siblings legitimately
  // reusing a value still serialise correctly (`finally` deletes on
  // the way out).
  if (seen.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  seen.add(value);
  try {
    // `JSON.stringify` calls `value.toJSON(key)` first when present
    // (passing `""` at the top level, the property name in object
    // positions, the index-as-string in array positions), then
    // serialises the return value. Canonical example: `Date` → ISO
    // string. The `key` argument is threaded through recursion so
    // user-side `toJSON(key)` implementations that branch on the
    // hosting property/index see the same value JSON.stringify would.
    // If `toJSON` returns `undefined`, that propagates as the omit
    // sentinel: the spec-defined "skip me" path.
    const maybeToJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJSON === "function") {
      return stableStringifyRec(
        (maybeToJSON as (key: string) => unknown).call(value, key),
        key,
        seen,
      );
    }
    // Boxed primitives (`new Number(3)`, `new String("x")`,
    // `new Boolean(true)`) unbox to their primitive JSON form,
    // mirroring `JSON.stringify`'s SerializeJSONProperty steps (which
    // apply ToNumber / ToString / [[BooleanData]] AFTER the toJSON
    // probe above). Without this branch they'd fall through to the
    // plain-object walk below and serialise as `"{}"` (no own
    // enumerable keys), so a config carrying one would hash
    // differently from the wire payload the cloud actually receives.
    // The consequence was only over-restarting (both compared hashes
    // come from this same function), but JSON parity is this file's
    // contract, so mirror the spec. Brand-checked via the
    // `Object.prototype.toString` tag rather than `instanceof`: the
    // internal-slot tag survives cross-realm values and prototype
    // surgery, which is exactly the unreliability
    // `unicorn/no-instanceof-builtins` exists to flag.
    const tag = Object.prototype.toString.call(value);
    if (
      tag === "[object Number]" ||
      tag === "[object String]" ||
      tag === "[object Boolean]"
    ) {
      return stableStringifyRec(
        (value as { valueOf(): unknown }).valueOf(),
        key,
        seen,
      );
    }
    if (Array.isArray(value)) {
      // Array slots: non-representable → "null" (matches JSON spec).
      // Index-as-string keys mirror `JSON.stringify`'s behaviour for
      // array elements (per the ECMAScript spec, `SerializeJSONArray`
      // calls `SerializeJSONProperty` with the index converted to a
      // string).
      //
      // `Array.from({ length })` (not `.map` / `for-of`) so sparse
      // array holes get substituted with `"null"` like
      // `JSON.stringify` does. `Array.prototype.map` and `for-of`
      // both SKIP holes entirely; using either path would render
      // `[, 1]` as the invalid `[,1]` instead of the JSON-spec
      // `[null,1]`. The `Array.from({ length: value.length })`
      // pattern iterates by index 0..length-1, reads each slot via
      // `value[i]` (which returns `undefined` for holes), and the
      // `?? "null"` fallback substitutes the spec-correct null.
      const items = Array.from(
        { length: value.length },
        (_, i) => stableStringifyRec(value[i], String(i), seen) ?? "null",
      );
      return `[${items.join(",")}]`;
    }
    // Object slots: skip keys whose serialised value is `undefined`
    // (matches `JSON.stringify({a: undefined}) === "{}"`). Property
    // names are passed as the recursion key so a nested `toJSON(key)`
    // sees the hosting field name.
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj).toSorted()) {
      const serialised = stableStringifyRec(obj[k], k, seen);
      if (serialised === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${serialised}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    // Drop the marker once we return from this node so a value
    // legitimately referenced from sibling positions (e.g. a shared
    // `dataset` object reused across two array slots) doesn't
    // false-positive as a cycle.
    seen.delete(value);
  }
}

function stableStringify(value: unknown, key = ""): string | undefined {
  return stableStringifyRec(value, key, new WeakSet());
}

/**
 * Stable fingerprint of a `JobConfig`. Used by HMR to decide whether a
 * rebuild changed only the in-process callbacks (configHash unchanged →
 * hot-swap) or the cloud-side training config (configHash changed →
 * full restart with `requestEarlyStop`).
 */
export function hashJobConfig(config: JobConfig): string {
  // Top-level fallback to `"null"` so a pathological config that
  // serialises to `undefined` (top-level `toJSON` returning
  // undefined, etc.) still produces a deterministic digest input
  // rather than crashing `createHash.update(undefined)`.
  const serialised = stableStringify(config) ?? "null";
  return createHash("sha256").update(serialised).digest("hex").slice(0, 16);
}
