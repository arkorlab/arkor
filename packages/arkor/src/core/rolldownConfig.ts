import { isAbsolute, resolve } from "node:path";
import type { InputOptions } from "rolldown";

const DEFAULT_ENTRY = "src/arkor/index.ts";
const DEFAULT_OUT_DIR = ".arkor/build";

export interface BuildEntryOptions {
  /** Source entry path; defaults to `src/arkor/index.ts`. */
  entry?: string;
  /** Output directory; defaults to `.arkor/build`. */
  outDir?: string;
  /** Project root; defaults to `process.cwd()`. */
  cwd?: string;
}

export interface ResolvedBuildEntry {
  /** Project root (absolute). */
  cwd: string;
  /** Entry source file (absolute). */
  entry: string;
  /** Output directory (absolute). */
  outDir: string;
  /** Output bundle (absolute, always `<outDir>/index.mjs`). */
  outFile: string;
}

/** Resolve `cwd` / `entry` / `outDir` to absolute paths with the standard defaults. */
export function resolveBuildEntry(opts: BuildEntryOptions): ResolvedBuildEntry {
  const cwd = opts.cwd ?? process.cwd();
  const entryRel = opts.entry ?? DEFAULT_ENTRY;
  const entry = isAbsolute(entryRel) ? entryRel : resolve(cwd, entryRel);
  const outDirRel = opts.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);
  const outFile = resolve(outDir, "index.mjs");
  return { cwd, entry, outDir, outFile };
}

/**
 * `node<major>.<minor>` derived from the running Node binary. Build host and
 * run host are effectively the same process (Studio spawns `arkor start` with
 * `process.execPath`), so the bundle can target precisely what will execute it.
 */
export function resolveNodeTarget(): string {
  const [major = "22", minor = "6"] = process.versions.node.split(".");
  return `node${major}.${minor}`;
}

/**
 * Build the shared rolldown options object used by both `runBuild` (one-shot)
 * and the HMR coordinator (`watch()`). Centralising the configuration here
 * keeps the two pipelines aligned: anything that affects the bundle shape —
 * external resolution, transform target, platform — is set in one place so
 * the artifact a watcher writes is byte-equivalent to a one-shot rebuild.
 */
export function rolldownInputOptions(
  resolved: Pick<ResolvedBuildEntry, "cwd" | "entry">,
): InputOptions {
  return {
    input: resolved.entry,
    cwd: resolved.cwd,
    platform: "node",
    logLevel: "warn",
    transform: { target: resolveNodeTarget() },
    // Mirror esbuild's `packages: "external"`: any specifier that isn't a
    // relative or absolute path stays external. `node:`-prefixed builtins
    // are already handled by `platform: "node"`; the explicit allow below
    // is a safety net in case the builtin set drifts.
    external: (id, _importer, isResolved) => {
      if (isResolved) return false;
      if (id.startsWith(".")) return false;
      if (isAbsolute(id)) return false;
      return true;
    },
  };
}

/**
 * Re-exported defaults so consumers (like error messages) can name the same
 * paths we resolve internally.
 */
export const BUILD_DEFAULTS = {
  entry: DEFAULT_ENTRY,
  outDir: DEFAULT_OUT_DIR,
} as const;
