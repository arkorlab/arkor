import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import { rolldown } from "rolldown";
import {
  BUILD_DEFAULTS,
  resolveBuildEntry,
  rolldownInputOptions,
} from "../../core/rolldownConfig";
import { ui } from "../prompts";

export interface BuildOptions {
  /** Source entry; defaults to `src/arkor/index.ts`. */
  entry?: string;
  /** Output directory; defaults to `.arkor/build`. */
  outDir?: string;
  /** Project root; defaults to `process.cwd()`. */
  cwd?: string;
  /** Suppress the success log line (used by `arkor start` auto-build). */
  quiet?: boolean;
}

export interface BuildResult {
  /** Absolute path to the source entry that was bundled. */
  entry: string;
  /** Absolute path to the produced `index.mjs` artifact. */
  outFile: string;
}

/**
 * Bundle the user's `src/arkor/index.ts` into a single ESM artifact at
 * `.arkor/build/index.mjs`.
 *
 * Bare specifiers (`arkor`, anything from `node_modules`) are kept external
 * so the artifact resolves the runtime SDK from the project's installed
 * copy. Relative imports are bundled inline. The transform target is
 * derived from the running Node binary (see `resolveNodeTarget`).
 */
export async function runBuild(opts: BuildOptions = {}): Promise<BuildResult> {
  const { cwd, entry, outDir, outFile } = resolveBuildEntry(opts);
  if (!existsSync(entry)) {
    throw new Error(
      `Build entry not found: ${entry}. Create ${BUILD_DEFAULTS.entry} or pass an explicit entry argument.`,
    );
  }
  await mkdir(outDir, { recursive: true });

  const bundle = await rolldown(rolldownInputOptions({ cwd, entry }));
  try {
    await bundle.write({ file: outFile, format: "esm" });
  } finally {
    await bundle.close();
  }

  if (!opts.quiet) {
    ui.log.success(
      `Built ${relative(cwd, entry) || entry} → ${relative(cwd, outFile) || outFile}`,
    );
  }
  return { entry, outFile };
}
