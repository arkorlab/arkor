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
 */
export async function readManifestSummary(cwd: string): Promise<ManifestSummary> {
  const { outFile } = await runBuild({ cwd, quiet: true });
  const url = `${pathToFileURL(outFile).href}?t=${Date.now()}`;
  const mod = (await import(url)) as Record<string, unknown>;
  const candidate = mod.arkor ?? mod.default;
  if (!isArkor(candidate)) return EMPTY;
  const trainer = candidate.trainer ? { name: candidate.trainer.name } : null;
  return { trainer };
}
