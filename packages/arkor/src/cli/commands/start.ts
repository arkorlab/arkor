import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runTrainer } from "../../core/runner";
import { runBuild } from "./build";

export interface StartOptions {
  /**
   * Optional entry override. When provided the project is rebuilt with this
   * entry before running. When omitted, an existing build artifact is reused
   * (and built on-demand if missing).
   */
  entry?: string;
  /** Output directory; defaults to `.arkor/build`. */
  outDir?: string;
  /** Project root; defaults to `process.cwd()`. */
  cwd?: string;
}

const DEFAULT_OUT_DIR = ".arkor/build";

/**
 * Execute the build artifact at `.arkor/build/index.mjs`. Mirrors `next start`:
 * the user's TS has already been compiled by `arkor build`, and this command
 * just imports the artifact and dispatches to the discovered trainer.
 *
 * For ergonomics, and so Studio's "Run training" button doesn't have to chain
 * two spawns: `start` auto-runs `build` when no artifact exists, or when an
 * explicit entry is provided.
 */
export async function runStart(opts: StartOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const outDirRel = opts.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);
  const outFile = resolve(outDir, "index.mjs");

  const needsBuild = Boolean(opts.entry) || !existsSync(outFile);
  if (needsBuild) {
    await runBuild({ cwd, outDir: outDirRel, entry: opts.entry });
  }

  await runTrainer(outFile);
}
