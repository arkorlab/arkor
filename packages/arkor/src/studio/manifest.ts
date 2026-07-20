import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * without restarting Studio, while unedited reloads reuse Node's ESM cache.
 *
 * The import goes through a CONTENT-ADDRESSED copy of the bundle
 * (`index.<sha256-prefix>.mjs`, written from the exact bytes that were
 * hashed), NOT the mutable `index.mjs` with a hash query. Two reasons:
 *
 *  - Keying: Node's ESM registry keys modules by full URL and retains every
 *    distinct URL permanently, so a per-call unique key (`Date.now()`, or an
 *    mtime, which esbuild refreshes every rebuild) would leak one module per
 *    home-page load across a long `arkor dev` session. A content hash busts
 *    the cache exactly when the user's source actually changed.
 *  - Integrity: importing the mutable `index.mjs` under a hash QUERY had a
 *    TOCTOU: a concurrent rebuild could overwrite the file between hashing
 *    and import, caching build B's module under build A's key; an editor
 *    undo back to A's exact bytes then served B's manifest until restart.
 *    Importing a copy written from the hashed bytes makes the URL name the
 *    evaluated bytes by construction. The copy lives in the same directory,
 *    so relative and bare-specifier resolution match `index.mjs` exactly.
 *
 * `importModule` is an injectable seam (default: dynamic `import`) so tests can
 * observe the import URL and assert the reuse-vs-bust behaviour directly.
 */

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

export async function readManifestSummary(
  cwd: string,
  importModule: (url: string) => Promise<Record<string, unknown>> = (u) =>
    import(u) as Promise<Record<string, unknown>>,
): Promise<ManifestSummary> {
  const { outFile } = await runBuild({ cwd, quiet: true });
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
  if (!existsSync(contentFile)) {
    // Best-effort cleanup of digest-addressed copies from earlier builds so
    // the directory holds at most a couple of snapshots. Deleting a file
    // another in-flight import still reads is safe on POSIX (the inode
    // outlives the unlink) and surfaces as a caught error on Windows.
    try {
      for (const entry of await readdir(buildDir)) {
        if (
          /^index\.[0-9a-f]{16}\.mjs$/.test(entry) &&
          entry !== `index.${digest}.mjs`
        ) {
          await rm(join(buildDir, entry), { force: true });
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
    // after the import resolves: concurrent requests that arrive while this
    // retry is still in flight then compute the SAME salted URL (Node
    // coalesces concurrent imports of one URL into a single evaluation)
    // instead of each bumping the salt and re-evaluating the user bundle
    // once per request. If the retry fails, the catch below re-arms the
    // flag so the NEXT request bumps again.
    state.failed = false;
  }
  const salt = state?.salt ?? 0;
  const url = salt === 0 ? key : `${key}?r=${salt}`;
  let mod: Record<string, unknown>;
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
  const candidate = mod.arkor ?? mod.default;
  if (!isArkor(candidate)) return EMPTY;
  const trainer = candidate.trainer ? { name: candidate.trainer.name } : null;
  return { trainer };
}
