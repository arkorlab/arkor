import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { build as esbuild } from "esbuild";
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

const DEFAULT_ENTRY = "src/arkor/index.ts";
const DEFAULT_OUT_DIR = ".arkor/build";

/**
 * Bundle the user's `src/arkor/index.ts` into a single ESM artifact at
 * `.arkor/build/index.mjs`.
 *
 * Bare specifiers (`arkor`, anything from `node_modules`) are kept external so
 * the artifact resolves the runtime SDK from the project's installed copy.
 * Relative imports are bundled inline.
 */
export async function runBuild(opts: BuildOptions = {}): Promise<BuildResult> {
  const cwd = opts.cwd ?? process.cwd();
  const entryRel = opts.entry ?? DEFAULT_ENTRY;
  const entry = isAbsolute(entryRel) ? entryRel : resolve(cwd, entryRel);
  if (!existsSync(entry)) {
    throw new Error(
      `Build entry not found: ${entry}. Create ${DEFAULT_ENTRY} or pass an explicit entry argument.`,
    );
  }

  const outDirRel = opts.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);
  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, "index.mjs");

  await esbuild({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.22",
    outfile: outFile,
    packages: "external",
    logLevel: "error",
  });

  if (!opts.quiet) {
    ui.log.success(
      `Built ${relative(cwd, entry) || entry} → ${relative(cwd, outFile) || outFile}`,
    );
  }
  return { entry, outFile };
}
