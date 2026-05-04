import { runBuild } from "../cli/commands/build";
import { hashJobConfig } from "../core/configHash";
import { moduleCacheBustUrl } from "../core/moduleCacheBust";
import {
  findTrainerInModule,
  getTrainerInspection,
} from "../core/trainerInspection";

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
  // mtime+size cache-bust (vs `Date.now()`): the SPA polls
  // `/api/manifest` every ~5 s, so a `Date.now()` suffix would
  // accumulate one ESM module record per poll across a long
  // `arkor dev` session — Node's loader has no eviction. Keying on
  // the artefact bytes collapses unchanged-poll reads onto the
  // existing record.
  const mod = (await import(moduleCacheBustUrl(outFile))) as Record<
    string,
    unknown
  >;
  // Walk every trainer export shape `runner.ts` accepts via the
  // shared helper (named `arkor`, named `trainer`, default Arkor
  // manifest, `default.trainer`) so manifest summary, HMR routing,
  // and runtime execution all agree about which exports count as a
  // trainer.
  const trainer = findTrainerInModule(mod);
  if (!trainer) return EMPTY;
  // Trainer name renders in the UI even for hand-rolled trainers
  // that bypass `createTrainer` and therefore don't carry the SDK
  // inspection brand. The brand is required only for the
  // `configHash` used by HMR routing — without it, HMR conservatively
  // SIGTERM-restarts on every rebuild (correct fallback).
  const name =
    typeof trainer.name === "string" ? trainer.name : "(unnamed trainer)";
  const inspection = getTrainerInspection(trainer);
  return {
    trainer: { name },
    configHash: inspection ? hashJobConfig(inspection.config) : null,
  };
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
