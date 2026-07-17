import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { runBuild } from "../cli/commands/build";
import { isArkor } from "../core/arkor";

/**
 * Wire-friendly snapshot of the user's `createArkor({...})` manifest. Mirrors
 * the runtime `Arkor` shape but keeps only fields the Studio UI can render
 * without re-importing the artifact.
 */
export interface ManifestSummary {
  trainer: { name: string } | null;
  // future: deploy: { name: string } | null;
  // future: eval:   { name: string } | null;
}

const EMPTY: ManifestSummary = { trainer: null };

/**
 * Build the user's `src/arkor/index.ts` and import the artifact to extract a
 * serialisable summary of its manifest. The Studio UI hits this on home-page
 * load to show *what* the project contains (just the trainer name today;
 * deploy / eval slots when those primitives land).
 *
 * Each call rebuilds and re-imports so edits to the user's source surface
 * without restarting Studio. The import URL carries a cache-bust query so
 * Node's ESM cache doesn't return a stale module.
 *
 * The query is a hash of the freshly-built bundle, NOT `Date.now()`. Node's
 * ESM registry keys modules by full URL (query included) and retains every
 * distinct URL permanently, so a per-call unique query would leak one module
 * per home-page load across a long `arkor dev` session. An mtime key wouldn't
 * help either (esbuild rewrites the bundle every build). Hashing the contents
 * busts the cache exactly when the user's source actually changed and reuses
 * a single registry entry across repeated loads with no edits.
 *
 * `importModule` is an injectable seam (default: dynamic `import`) so tests can
 * observe the cache-bust URL and assert the reuse-vs-bust behaviour directly.
 */

// Node's ESM registry caches FAILED evaluations by URL too: a bundle whose
// top-level code threw because of an external runtime condition (e.g. a
// `readFileSync` of a config file that doesn't exist yet) would stay a cached
// rejection under a pure content-hash key, since fixing the external condition
// doesn't change the bundle bytes. Track the last import's outcome and bump a
// retry salt after a failure so the next request re-imports; a successful
// salted URL is then reused, keeping the no-edit steady state at one registry
// entry per distinct build.
let lastImportKey: string | null = null;
let lastImportFailed = false;
let retrySalt = 0;

export async function readManifestSummary(
  cwd: string,
  importModule: (url: string) => Promise<Record<string, unknown>> = (u) =>
    import(u) as Promise<Record<string, unknown>>,
): Promise<ManifestSummary> {
  const { outFile } = await runBuild({ cwd, quiet: true });
  const digest = createHash("sha256")
    .update(await readFile(outFile))
    .digest("hex")
    .slice(0, 16);
  const key = `${pathToFileURL(outFile).href}?t=${digest}`;
  if (key !== lastImportKey) {
    lastImportKey = key;
    retrySalt = 0;
    lastImportFailed = false;
  } else if (lastImportFailed) {
    retrySalt++;
    // Cleared HERE, in the same synchronous block as the salt bump, not
    // after the import resolves: concurrent requests that arrive while this
    // retry is still in flight then compute the SAME salted URL (Node
    // coalesces concurrent imports of one URL into a single evaluation)
    // instead of each bumping the salt and re-evaluating the user bundle
    // once per request. If the retry fails, the catch below re-arms the
    // flag so the NEXT request bumps again.
    lastImportFailed = false;
  }
  const url = retrySalt === 0 ? key : `${key}&r=${retrySalt}`;
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(url);
  } catch (err) {
    lastImportFailed = true;
    throw err;
  }
  const candidate = mod.arkor ?? mod.default;
  if (!isArkor(candidate)) return EMPTY;
  const trainer = candidate.trainer ? { name: candidate.trainer.name } : null;
  return { trainer };
}
