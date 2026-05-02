import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { watch, type RolldownWatcher } from "rolldown";
import { isArkor } from "../core/arkor";
import { hashJobConfig } from "../core/configHash";
import {
  BUILD_DEFAULTS,
  resolveBuildEntry,
  rolldownInputOptions,
  type BuildEntryOptions,
} from "../core/rolldownConfig";
import { getTrainerInspection } from "../core/trainerInspection";

export type HmrEventType = "ready" | "rebuild" | "error";

export interface HmrEvent {
  type: HmrEventType;
  outFile?: string;
  /**
   * Short fingerprint of the bundle artefact (mtime + size). Subscribers
   * use this to dedupe replays of the same successful build.
   */
  hash?: string;
  /**
   * Stable hash of the trainer's cloud-side `JobConfig`. When this is
   * unchanged across a rebuild, only the in-process callbacks moved and
   * the Studio server can hot-swap them without restarting the run.
   * `null` when the bundle has no discoverable trainer (e.g. the user's
   * source has a syntax error or the Arkor manifest is missing).
   */
  configHash?: string | null;
  /** Run name pulled from the rebuilt manifest. */
  trainerName?: string | null;
  /** Human-readable error message; only present on `type === "error"`. */
  message?: string;
}

export interface HmrCoordinator {
  /**
   * Receive the current cached state immediately, then every subsequent
   * event. Returns an unsubscribe function.
   */
  subscribe(fn: (event: HmrEvent) => void): () => void;
  dispose(): Promise<void>;
}

export type HmrOptions = BuildEntryOptions;

function fingerprint(outFile: string): string {
  try {
    const s = statSync(outFile);
    return `${s.mtimeMs.toFixed(0)}-${s.size}`;
  } catch {
    return Date.now().toString(36);
  }
}

/**
 * Dynamic-import the freshly-built bundle and pull a `TrainerInspection`
 * snapshot off the discovered trainer. Cache-bust the URL so Node's ESM
 * loader returns the new module text rather than a stale evaluation. Best-
 * effort: a missing/malformed manifest or a thrown user constructor returns
 * `null` and the caller treats the rebuild as "config-unknown".
 */
async function inspectBundle(
  outFile: string,
): Promise<{ configHash: string; trainerName: string } | null> {
  try {
    const url = `${pathToFileURL(outFile).href}?t=${Date.now()}`;
    const mod = (await import(url)) as Record<string, unknown>;
    const candidate = mod.arkor ?? mod.default;
    if (!isArkor(candidate)) return null;
    const inspection = getTrainerInspection(candidate.trainer);
    if (!inspection) return null;
    return {
      configHash: hashJobConfig(inspection.config),
      trainerName: inspection.name,
    };
  } catch {
    return null;
  }
}

/**
 * Spin up a rolldown watcher over the user's `src/arkor` entry, broadcasting
 * `ready` / `rebuild` / `error` to subscribers. Used by `arkor dev` to push
 * `/api/dev/events` SSE notifications to the SPA.
 *
 * Lazy: the watcher only starts on the first `subscribe` call so a Studio
 * launch in a project without `src/arkor/index.ts` doesn't immediately fail
 * — the watcher kicks in once the user creates the file and the SPA opens
 * an EventSource. After every successful build the watcher caches the
 * latest state and replays it to new subscribers so a late-mounting
 * component still sees the trainer.
 */
export function createHmrCoordinator(opts: HmrOptions): HmrCoordinator {
  const resolved = resolveBuildEntry(opts);

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
        // Subscribers are SSE controllers — a thrown error usually means
        // the connection closed mid-flight. Drop it so one bad subscriber
        // can't poison the broadcast for the rest.
      }
    }
  }

  async function emitBuildSucceeded(eventType: HmrEventType): Promise<void> {
    if (disposed) return;
    const inspection = await inspectBundle(resolved.outFile);
    broadcast({
      type: eventType,
      outFile: resolved.outFile,
      hash: fingerprint(resolved.outFile),
      configHash: inspection?.configHash ?? null,
      trainerName: inspection?.trainerName ?? null,
    });
  }

  function startWatcher(): void {
    if (watcher || disposed) return;
    if (!existsSync(resolved.entry)) {
      broadcast({
        type: "error",
        message: `Build entry not found: ${resolved.entry}. Create ${BUILD_DEFAULTS.entry} or pass an explicit entry argument.`,
      });
      return;
    }
    watcher = watch({
      ...rolldownInputOptions(resolved),
      output: { file: resolved.outFile, format: "esm" },
    });
    let firstBuild = true;
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_END") {
        // rolldown requires the per-build result to be closed to avoid leaks.
        event.result.close().catch(() => {});
        const type: HmrEventType = firstBuild ? "ready" : "rebuild";
        firstBuild = false;
        void emitBuildSucceeded(type);
      } else if (event.code === "ERROR") {
        event.result.close().catch(() => {});
        broadcast({
          type: "error",
          message:
            event.error instanceof Error
              ? event.error.message
              : String(event.error),
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
