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
  // `resolve()` (not a bare `??` fallback) so a RELATIVE `opts.cwd`
  // also honours the "project root (absolute)" contract this return
  // type documents; `entry`/`outDir` below already resolve against it.
  const cwd = resolve(opts.cwd ?? process.cwd());
  const entryRel = opts.entry ?? DEFAULT_ENTRY;
  const entry = isAbsolute(entryRel) ? entryRel : resolve(cwd, entryRel);
  const outDirRel = opts.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);
  const outFile = resolve(outDir, "index.mjs");
  return { cwd, entry, outDir, outFile };
}

/**
 * Rolldown transform target for user bundles: the published
 * `engines.node` floor (`>=22.22.0` in [packages/arkor/package.json];
 * see AGENTS.md's "Node version" note), NOT the build host's runtime.
 *
 * Codex P2 (PR #101 round 82): a host-derived target (the previous
 * `process.versions.node` shape) is only safe when build host and run
 * host are the same binary. That holds for the Studio flow (Studio
 * spawns `arkor start` with `process.execPath`), but `arkor build`
 * artifacts are documented for CI / servers / scripts: built on
 * Node 24, an artifact could keep syntax the supported Node 22.22
 * floor cannot parse and crash at `arkor start` on the older host.
 * Targeting the floor keeps every artifact runnable on every engine
 * the package declares, and costs nothing on newer hosts (downlevel
 * output parses everywhere).
 *
 * Keep this in lockstep with `engines.node` when the floor is raised.
 */
export function resolveNodeTarget(): string {
  return "node22.22";
}

/**
 * Build the shared rolldown options object used by both `runBuild` (one-shot)
 * and the HMR coordinator (`watch()`). Centralising the configuration here
 * keeps the two pipelines aligned: anything that affects the bundle shape
 * (external resolution, transform target, platform) is set in one place so
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
