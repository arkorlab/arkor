import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { runBuild } from "../cli/commands/build";
import { hashJobConfig } from "../core/configHash";
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

/** Injectable import seam so tests can observe URLs and control failures. */
export type ImportModuleFn = (url: string) => Promise<Record<string, unknown>>;

const defaultImportModule: ImportModuleFn = (u) =>
  import(u) as Promise<Record<string, unknown>>;

// Node's ESM registry caches FAILED evaluations by URL too: a bundle whose
// top-level code threw because of an external runtime condition (e.g. a
// `readFileSync` of a config file that doesn't exist yet) would stay a cached
// rejection under a pure content-hash key, since fixing the external condition
// doesn't change the bundle bytes. Track each key's import outcome and bump a
// retry salt after a failure so the next request re-imports; a successful
// salted URL is then reused, keeping the no-edit steady state at one registry
// entry per distinct build.
//
// State is PER KEY (not module-global): with a single shared slot, a late
// failure from build A landing after build B's read had reset the slot would
// mark B as failed (a pointless re-evaluation) and lose A's failure signal,
// so A's next read would reuse Node's cached rejection: the exact sticky
// failure this mechanism exists to prevent. Keys that never fail get no
// entry, so the map only grows with distinct failed builds.
interface ImportRetryState {
  salt: number;
  failed: boolean;
}
const importRetryStates = new Map<string, ImportRetryState>();

// Snapshots currently referenced by an in-flight request (selected but whose
// dynamic import has not yet settled), refcounted because concurrent requests
// can share a digest. The stale-snapshot cleanup skips these: an unlink
// between a request's selection and its import's open() would ENOENT that
// request (the POSIX "inode outlives the unlink" property only protects
// already-open descriptors, not paths still waiting to be opened). In-process
// tracking fully covers a single `arkor dev`; two instances serving the SAME
// project directory could still race each other's cleanup cross-process, the
// same accepted residual class as the shared studio-token file.
const activeContentFiles = new Map<string, number>();

function retainContentFile(path: string): void {
  activeContentFiles.set(path, (activeContentFiles.get(path) ?? 0) + 1);
}

function releaseContentFile(path: string): void {
  const count = activeContentFiles.get(path) ?? 0;
  if (count <= 1) {
    activeContentFiles.delete(path);
  } else {
    activeContentFiles.set(path, count - 1);
  }
}

/**
 * Dynamic-import an already-built artefact and pull a serialisable summary
 * off its trainer.
 *
 * Split out of `readManifestSummary` so callers that already have a fresh
 * artefact (the HMR coordinator keeps `.arkor/build/index.mjs` continuously
 * rebuilt) can inspect it without paying for a redundant `runBuild()`.
 *
 * The import goes through a CONTENT-ADDRESSED copy of the bundle
 * (`index.<sha256-prefix>.mjs`, written from the exact bytes that were
 * hashed), NOT the mutable `index.mjs` with a hash query. Two reasons:
 *
 *  - Keying: Node's ESM registry keys modules by full URL and retains every
 *    distinct URL permanently, so a per-call unique key (`Date.now()`, or an
 *    mtime, which the bundler refreshes every rebuild) would leak one module
 *    per home-page load across a long `arkor dev` session. A content hash
 *    busts the cache exactly when the user's source actually changed.
 *  - Integrity: importing the mutable `index.mjs` under a hash QUERY had a
 *    TOCTOU: a concurrent rebuild (including the HMR watcher's atomic
 *    rename-publish) could overwrite the file between hashing and import,
 *    caching build B's module under build A's key; an editor undo back to
 *    A's exact bytes then served B's manifest until restart. Importing a
 *    copy written from the hashed bytes makes the URL name the evaluated
 *    bytes by construction. The copy lives in the same directory, so
 *    relative and bare-specifier resolution match `index.mjs` exactly.
 *
 * `importModule` is an injectable seam (default: dynamic `import`) so tests
 * can observe the import URL and assert the reuse-vs-bust behaviour directly.
 */
export async function summariseBuiltManifest(
  outFile: string,
  importModule: ImportModuleFn = defaultImportModule,
): Promise<ManifestSummary> {
  const bytes = await readFile(outFile);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  // Materialise the exact hashed bytes at a digest-addressed sibling and
  // import THAT file (see the doc comment above for why importing the
  // mutable outFile under a hash query is not sound). Written atomically
  // (unique temp + rename, matching the credentials/studio-token pattern)
  // so a concurrent request with the same digest can never observe a
  // partial copy; when the file already exists its bytes are identical by
  // construction, so the write is skipped.
  const buildDir = dirname(outFile);
  const contentFile = join(buildDir, `index.${digest}.mjs`);
  // Retained until the import settles so a concurrent request's cleanup
  // (below) can never unlink the snapshot this request is about to open.
  retainContentFile(contentFile);
  let mod: Record<string, unknown>;
  try {
    if (!existsSync(contentFile)) {
      // Best-effort cleanup of digest-addressed copies from earlier builds
      // so the directory holds at most a couple of snapshots. Skips any
      // snapshot an in-flight request still references (see
      // activeContentFiles above); other failures (e.g. Windows EBUSY) are
      // swallowed and retried by a later request's cleanup pass. The
      // pattern is scoped to `index.<hex16>.mjs`, so the watcher-owned
      // `index.mjs` and its `.hmr-staging` sibling are never touched.
      try {
        for (const entry of await readdir(buildDir)) {
          const full = join(buildDir, entry);
          if (
            /^index\.[0-9a-f]{16}\.mjs$/.test(entry) &&
            entry !== `index.${digest}.mjs` &&
            !activeContentFiles.has(full)
          ) {
            await rm(full, { force: true });
          }
        }
      } catch {
        // best-effort
      }
      const tmp = `${contentFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, bytes);
        await rename(tmp, contentFile);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    }
    const key = pathToFileURL(contentFile).href;
    const state = importRetryStates.get(key);
    if (state?.failed) {
      state.salt++;
      // Cleared HERE, in the same synchronous block as the salt bump, not
      // after the import resolves: concurrent requests that arrive while
      // this retry is still in flight then compute the SAME salted URL
      // (Node coalesces concurrent imports of one URL into a single
      // evaluation) instead of each bumping the salt and re-evaluating the
      // user bundle once per request. If the retry fails, the catch below
      // re-arms the flag so the NEXT request bumps again.
      state.failed = false;
    }
    const salt = state?.salt ?? 0;
    const url = salt === 0 ? key : `${key}?r=${salt}`;
    try {
      mod = await importModule(url);
    } catch (err) {
      const failedState = importRetryStates.get(key) ?? {
        salt: 0,
        failed: false,
      };
      failedState.failed = true;
      importRetryStates.set(key, failedState);
      throw err;
    }
  } finally {
    releaseContentFile(contentFile);
  }
  // Walk every trainer export shape `runner.ts` accepts via the shared
  // helper (named `arkor` manifest or bare Trainer, named `trainer`,
  // default Arkor manifest, bare default Trainer, `default.trainer`) so
  // manifest summary, HMR routing, and runtime execution all agree about
  // which exports count as a trainer.
  const trainer = findTrainerInModule(mod);
  if (!trainer) return EMPTY;
  // Trainer name renders in the UI even for hand-rolled trainers that
  // bypass `createTrainer` and therefore don't carry the SDK inspection
  // brand. The brand is required only for the `configHash` used by HMR
  // routing; without it, HMR conservatively SIGTERM-restarts on every
  // rebuild (correct fallback).
  const name =
    typeof trainer.name === "string" ? trainer.name : "(unnamed trainer)";
  const inspection = getTrainerInspection(trainer);
  // `hashJobConfig` throws on unhashable configs (circular refs in an
  // `unknown` field, etc.). For the manifest the trainer NAME is
  // still perfectly renderable, so degrade to `configHash: null`
  // (the documented "config not diffable -> conservative
  // SIGTERM-restart" state) instead of 400-ing the whole summary
  // (cubic P2, round 86). `runnerSignals` makes the same choice;
  // only `hmr`'s inspection propagates, because there the throw is
  // what surfaces the error frame.
  let configHash: string | null = null;
  if (inspection) {
    try {
      configHash = hashJobConfig(inspection.config);
    } catch {
      // unhashable config: fall through with null
    }
  }
  return {
    trainer: { name },
    configHash,
  };
}

export interface ReadManifestOptions {
  /**
   * HMR-aware fast path: when set, `runBuild()` is NEVER invoked; the
   * watcher owns `.arkor/build/index.mjs` end to end and this artefact
   * is inspected directly. Re-running `runBuild()` on every
   * `/api/manifest` poll (every ~5 s + on every rebuild SSE event) is
   * wasted CPU AND races the watcher writing to the same path. A
   * missing artefact (fresh scaffold, first poll landing before the
   * watcher's first BUNDLE_END) yields the empty summary for that
   * poll; the watcher's BUNDLE_END SSE event triggers an immediate SPA
   * refetch, so the empty state lasts one poll at most.
   *
   * Pass `coordinator.outFile`-equivalent (e.g.
   * `resolveBuildEntry({ cwd }).outFile`) here when the server has
   * an active `HmrCoordinator`; leave undefined when HMR is off so
   * the build path runs as before.
   */
  prebuiltOutFile?: string;
  /** Test seam forwarded to `summariseBuiltManifest`. */
  importModule?: ImportModuleFn;
}

/**
 * Build the user's `src/arkor/index.ts` and import the artifact to
 * extract a serialisable summary of its manifest. The Studio UI hits
 * this on home-page load to show *what* the project contains (just the
 * trainer name today; deploy / eval slots when those primitives land).
 *
 * Each call rebuilds and re-imports so edits to the user's source
 * surface without restarting Studio, while unedited reloads reuse
 * Node's ESM cache (see `summariseBuiltManifest` for the
 * content-addressed import that makes that sound). When
 * `prebuiltOutFile` is supplied (HMR-enabled servers), the `runBuild()`
 * step is bypassed entirely (see `ReadManifestOptions.prebuiltOutFile`).
 */
export async function readManifestSummary(
  cwd: string,
  opts: ReadManifestOptions = {},
): Promise<ManifestSummary> {
  if (opts.prebuiltOutFile) {
    // HMR mode: the watcher owns `.arkor/build/index.mjs` end to end.
    // When the artefact doesn't exist yet (fresh scaffold, first poll
    // landing before the watcher's first BUNDLE_END), return the
    // empty summary instead of bootstrapping via `runBuild()`
    // (CodeRabbit, round 82): that bootstrap wrote the watcher-owned
    // outFile OUTSIDE the staging + rename protocol, so a concurrent
    // `/api/train` spawn (whose `runStart` skips its own rebuild the
    // moment the file exists) could dynamic-import partial bytes.
    if (!existsSync(opts.prebuiltOutFile)) return EMPTY;
    // No `runBuild()` fallback on import failure either, deliberately:
    // an import failure of an EXISTING atomically-published artefact
    // means the bundle genuinely throws at import time; rebuilding the
    // same source can't fix that, and a fallback build would race the
    // watcher. Rethrowing lets `/api/manifest` surface the import
    // error as a 400 (the HMR coordinator broadcasts its own matching
    // `error` frame for the same broken bundle, so both channels
    // agree).
    return summariseBuiltManifest(opts.prebuiltOutFile, opts.importModule);
  }
  const { outFile } = await runBuild({ cwd, quiet: true });
  return summariseBuiltManifest(outFile, opts.importModule);
}
