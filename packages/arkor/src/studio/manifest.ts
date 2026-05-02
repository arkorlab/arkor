import { pathToFileURL } from "node:url";
import { runBuild } from "../cli/commands/build";
import { isArkor } from "../core/arkor";
import { hashJobConfig } from "../core/configHash";
import { getTrainerInspection } from "../core/trainerInspection";

/**
 * Wire-friendly snapshot of the user's `createArkor({...})` manifest. Mirrors
 * the runtime `Arkor` shape but keeps only fields the Studio UI can render
 * without re-importing the artifact.
 */
export interface ManifestSummary {
  trainer: { name: string } | null;
  /**
   * Stable hash of the trainer's cloud-side `JobConfig`. Used by HMR to
   * decide whether a rebuild only changed in-process callbacks (hash
   * unchanged → hot-swap) or also touched cloud-side training config
   * (hash changed → restart with `requestEarlyStop`). `null` when no
   * inspectable trainer is present.
   */
  configHash: string | null;
  // future: deploy: { name: string } | null;
  // future: eval:   { name: string } | null;
}

const EMPTY: ManifestSummary = { trainer: null, configHash: null };

/**
 * Dynamic-import an already-built artefact and pull a serialisable
 * summary off its trainer. Cache-bust the URL so Node's ESM loader
 * returns the fresh module text rather than a stale evaluation.
 *
 * Split out of `readManifestSummary` so callers that already triggered a
 * build (the HMR coordinator hands the SPA a `outFile` after each
 * `BUNDLE_END`) can inspect the artefact without paying for a redundant
 * `runBuild()`.
 */
export async function summariseBuiltManifest(
  outFile: string,
): Promise<ManifestSummary> {
  const url = `${pathToFileURL(outFile).href}?t=${Date.now()}`;
  const mod = (await import(url)) as Record<string, unknown>;
  const candidate = mod.arkor ?? mod.default;
  if (!isArkor(candidate)) return EMPTY;
  const trainer = candidate.trainer
    ? { name: candidate.trainer.name }
    : null;
  const inspection = getTrainerInspection(candidate.trainer);
  const configHash = inspection ? hashJobConfig(inspection.config) : null;
  return { trainer, configHash };
}

/**
 * Build the user's `src/arkor/index.ts` and import the artifact to
 * extract a serialisable summary of its manifest. The Studio UI hits
 * this on home-page load to show *what* the project contains (just the
 * trainer name today; deploy / eval slots when those primitives land).
 *
 * Each call rebuilds and re-imports so edits to the user's source
 * surface without restarting Studio.
 */
export async function readManifestSummary(
  cwd: string,
): Promise<ManifestSummary> {
  const { outFile } = await runBuild({ cwd, quiet: true });
  return summariseBuiltManifest(outFile);
}
