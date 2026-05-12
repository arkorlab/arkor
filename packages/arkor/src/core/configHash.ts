import { createHash } from "node:crypto";
import type { JobConfig } from "./types";

/**
 * Deterministic JSON serialiser: keys sorted at every nesting level so
 * `{a:1, b:2}` and `{b:2, a:1}` produce the same string. Necessary because
 * `JSON.stringify` follows insertion order, which isn't stable across
 * `buildJobConfig` revisions or user-side spread-merge tricks.
 *
 * Returns `string | undefined`. `undefined` is the "omit me from my
 * containing object" sentinel — it propagates from any value
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
 * object slots as `{"a":null}` instead of the JSON-correct `{}` —
 * making `configHash` diverge from the wire-format payload for
 * `JobConfig` fields whose `toJSON(key)` happened to return
 * `undefined` (the spec-defined "skip me" signal). That divergence
 * forces unnecessary SIGTERM restarts on every rebuild.
 */
function stableStringify(value: unknown, key: string = ""): string | undefined {
  if (value === null) return "null";
  // Non-representable values: omit (undefined return) so each caller's
  // boundary handler chooses the right substitution per its position.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value !== "object") return JSON.stringify(value);
  // `JSON.stringify` calls `value.toJSON(key)` first when present
  // (passing `""` at the top level, the property name in object
  // positions, the index-as-string in array positions), then
  // serialises the return value. Canonical example: `Date` → ISO
  // string. The `key` argument is threaded through recursion so
  // user-side `toJSON(key)` implementations that branch on the
  // hosting property/index see the same value JSON.stringify would.
  // If `toJSON` returns `undefined`, that propagates as the omit
  // sentinel — the spec-defined "skip me" path.
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
    const items = value.map((v, i) => stableStringify(v, String(i)) ?? "null");
    return `[${items.join(",")}]`;
  }
  // Object slots: skip keys whose serialised value is `undefined`
  // (matches `JSON.stringify({a: undefined}) === "{}"`). Property
  // names are passed as the recursion key so a nested `toJSON(key)`
  // sees the hosting field name.
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const serialised = stableStringify(obj[k], k);
    if (serialised === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${serialised}`);
  }
  return `{${parts.join(",")}}`;
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
