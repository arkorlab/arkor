import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Monotonic counter for the read-failure fallback below. Each failure
 * gets a UNIQUE key on purpose: a stable sentinel (the previous
 * `"0-0-0"`) could be poisoned. If the file was missing at key time
 * but appeared before the loader's own read (watcher rename landing
 * in between), the module would be cached under the shared sentinel,
 * and every LATER missing-file call would silently get that stale
 * module instead of the loader's clean "file not found" error. A
 * unique token per failure keeps each such race isolated; the leak
 * bound is "one ESM record per failure that happened to win the
 * race", which is effectively zero in practice.
 */
let missSeq = 0;

/**
 * Build a content-derived cache-bust query for `await import(url + "?t=" + key)`.
 *
 * Why this matters: Node's ESM loader caches every dynamically-imported
 * URL for the lifetime of the process and exposes no API to evict a
 * record. A naive `?t=Date.now()` cache-bust produces a fresh URL on
 * every call, so a long-running `arkor dev` session (where the SPA
 * polls `/api/manifest` every few seconds and every save fires
 * `BUNDLE_END` + SIGUSR2) accumulates one module record per call,
 * unbounded.
 *
 * The key is a truncated sha256 of the file BYTES. Repeated reads of
 * the same content collapse onto the same URL, which Node's loader
 * then serves from its existing cache record. The leak shrinks from
 * "one entry per call" to "one entry per distinct file content",
 * which is the tightest bound we can offer without spawning a child
 * process per import.
 *
 * Content (vs the previous `mtimeMs-ctimeMs-size` stat key): the stat
 * key could COLLIDE for two different builds. Kernel file-timestamp
 * granularity is coarse (a jiffy, ~1-10 ms, on common Linux configs),
 * so two consecutive watcher publishes inside one tick with
 * identical output size would produce the same key, and the loader
 * would return the STALE module for the second build. Every consumer
 * is a production HMR path (`hmr.ts` inspection → configHash routing,
 * `manifest.ts` summaries, `runnerSignals.ts` SIGUSR2 callback
 * reload), so a collision means stale code is reported as
 * hot-reloaded. Hashing the bytes makes the key collision-free for
 * distinct content; as a bonus, rebuilds that emit identical bytes
 * now reuse one record instead of two. The artefacts hashed here are
 * user-project bundles (typically KBs to low MBs), so the extra read
 * + sha256 per import/poll is negligible next to the import itself.
 *
 * Falls back to a unique `miss-<n>` token when the file can't be read
 * (missing artefact, fresh project): the eventual `import()` then
 * surfaces its own clean error. See `missSeq` for why the token must
 * not be a shared constant.
 */
export function moduleCacheBustKey(filePath: string): string {
  try {
    const bytes = readFileSync(filePath);
    return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  } catch {
    missSeq += 1;
    return `miss-${missSeq}`;
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
