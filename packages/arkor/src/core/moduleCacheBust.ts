import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Build a content-derived cache-bust query for `await import(url + "?t=" + key)`.
 *
 * Why this matters: Node's ESM loader caches every dynamically-imported
 * URL for the lifetime of the process and exposes no API to evict a
 * record. A naive `?t=Date.now()` cache-bust produces a fresh URL on
 * every call, so a long-running `arkor dev` session — where the SPA
 * polls `/api/manifest` every few seconds and every save fires
 * `BUNDLE_END` + SIGUSR2 — accumulates one module record per call,
 * unbounded.
 *
 * Keying on `mtime + size` collapses repeated reads of the same bytes
 * onto the same URL, which Node's loader then serves from its existing
 * cache record. The leak shrinks from "one entry per call" to "one
 * entry per actual file change", which is the tightest bound we can
 * offer without spawning a child process per import.
 *
 * Falls back to a stable literal on stat failure so the eventual
 * `import()` (which will throw on a missing file) gets to surface its
 * own clean error rather than us inventing a noisy timestamp here.
 */
export function moduleCacheBustKey(filePath: string): string {
  try {
    const s = statSync(filePath);
    return `${s.mtimeMs.toFixed(0)}-${s.size}`;
  } catch {
    return "0-0";
  }
}

/**
 * Convenience: full file URL with the cache-bust key already
 * appended. The `as const`-style template is small enough to inline
 * but doing it in one place keeps the URL shape uniform across the
 * three callers (`hmr.ts`, `manifest.ts`, `runnerSignals.ts`).
 */
export function moduleCacheBustUrl(filePath: string): string {
  return `${pathToFileURL(filePath).href}?t=${moduleCacheBustKey(filePath)}`;
}
