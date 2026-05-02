import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { watch, type RolldownWatcher } from "rolldown";

export type HmrEventType = "ready" | "rebuild" | "error";

export interface HmrEvent {
  type: HmrEventType;
  outFile?: string;
  /** Short content fingerprint (mtime + size) so subscribers can dedupe. */
  hash?: string;
  /** Human-readable error message; only present on `type === "error"`. */
  message?: string;
}

export interface HmrCoordinator {
  /**
   * Receive the current cached state immediately, then every subsequent event.
   * Returns an unsubscribe function.
   */
  subscribe(fn: (event: HmrEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface HmrOptions {
  cwd: string;
  /** Defaults to `src/arkor/index.ts`. */
  entry?: string;
  /** Defaults to `.arkor/build`. */
  outDir?: string;
}

const DEFAULT_ENTRY = "src/arkor/index.ts";
const DEFAULT_OUT_DIR = ".arkor/build";

function resolveNodeTarget(): string {
  const [major = "22", minor = "6"] = process.versions.node.split(".");
  return `node${major}.${minor}`;
}

function fingerprint(outFile: string): string {
  try {
    const s = statSync(outFile);
    return `${s.mtimeMs.toFixed(0)}-${s.size}`;
  } catch {
    return Date.now().toString(36);
  }
}

/**
 * Spin up a rolldown watcher over the user's `src/arkor` entry, broadcasting
 * `ready` / `rebuild` / `error` to subscribers. Used by `arkor dev` to push
 * `/api/dev/events` SSE notifications to the SPA.
 *
 * Lazy: the watcher only starts on the first `subscribe` call so a Studio
 * launch in a project without `src/arkor/index.ts` doesn't immediately fail
 * — the watcher kicks in once the user creates the file and the SPA opens an
 * EventSource. After every successful build the watcher caches the latest
 * state and replays it to new subscribers so a late-mounting component still
 * sees the trainer.
 */
export function createHmrCoordinator(opts: HmrOptions): HmrCoordinator {
  const cwd = opts.cwd;
  const entryRel = opts.entry ?? DEFAULT_ENTRY;
  const entry = isAbsolute(entryRel) ? entryRel : resolve(cwd, entryRel);
  const outDirRel = opts.outDir ?? DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRel) ? outDirRel : resolve(cwd, outDirRel);
  const outFile = resolve(outDir, "index.mjs");

  const subscribers = new Set<(event: HmrEvent) => void>();
  let lastEvent: HmrEvent | null = null;
  let watcher: RolldownWatcher | null = null;
  let disposed = false;

  function broadcast(event: HmrEvent): void {
    lastEvent = event;
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        // Subscribers are SSE controllers — a thrown error usually means the
        // connection closed mid-flight. Drop it so one bad subscriber can't
        // poison the broadcast for the rest.
      }
    }
  }

  function startWatcher(): void {
    if (watcher || disposed) return;
    if (!existsSync(entry)) {
      broadcast({
        type: "error",
        message: `Build entry not found: ${entry}. Create ${DEFAULT_ENTRY} or pass an explicit entry argument.`,
      });
      return;
    }
    watcher = watch({
      input: entry,
      cwd,
      platform: "node",
      logLevel: "warn",
      transform: { target: resolveNodeTarget() },
      external: (id, _importer, isResolved) => {
        if (isResolved) return false;
        if (id.startsWith(".")) return false;
        if (isAbsolute(id)) return false;
        return true;
      },
      output: { file: outFile, format: "esm" },
    });
    let firstBuild = true;
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_END") {
        // rolldown requires the per-build result to be closed to avoid leaks.
        event.result.close().catch(() => {});
        const type: HmrEventType = firstBuild ? "ready" : "rebuild";
        firstBuild = false;
        broadcast({ type, outFile, hash: fingerprint(outFile) });
      } else if (event.code === "ERROR") {
        event.result.close().catch(() => {});
        broadcast({
          type: "error",
          message: event.error instanceof Error ? event.error.message : String(event.error),
        });
      }
    });
  }

  return {
    subscribe(fn) {
      subscribers.add(fn);
      if (lastEvent) fn(lastEvent);
      startWatcher();
      return () => {
        subscribers.delete(fn);
      };
    },
    async dispose() {
      disposed = true;
      subscribers.clear();
      if (watcher) {
        const w = watcher;
        watcher = null;
        await w.close().catch(() => {});
      }
    },
  };
}
