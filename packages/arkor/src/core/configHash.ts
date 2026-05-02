import { createHash } from "node:crypto";
import type { JobConfig } from "./types";

/**
 * Deterministic JSON serialiser: keys sorted at every nesting level so
 * `{a:1, b:2}` and `{b:2, a:1}` produce the same string. Necessary because
 * `JSON.stringify` follows insertion order, which isn't stable across
 * `buildJobConfig` revisions or user-side spread-merge tricks.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${stableStringify(
        (value as Record<string, unknown>)[k],
      )}`,
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
