import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { rolldown } from "rolldown";
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
 * `node<major>.<minor>` derived from the running Node binary. Build host and run
 * host are effectively the same process: Studio spawns `arkor start` with
 * `process.execPath`, so the bundle can target precisely what will execute it.
 */
function resolveNodeTarget(): string {
  const [major = "22", minor = "6"] = process.versions.node.split(".");
  return `node${major}.${minor}`;
}

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

  const bundle = await rolldown({
    input: entry,
    cwd,
    platform: "node",
    logLevel: "warn",
    transform: { target: resolveNodeTarget() },
    // Mirror esbuild's `packages: "external"`: any specifier that isn't a
    // relative or absolute path stays external. `node:`-prefixed builtins are
    // already handled by `platform: "node"` but we keep the explicit allow as
    // a safety net in case the builtin set drifts.
    external: (id, _importer, isResolved) => {
      if (isResolved) return false;
      if (id.startsWith(".")) return false;
      if (isAbsolute(id)) return false;
      return true;
    },
  });
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
