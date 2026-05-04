import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { watch, type RolldownWatcher } from "rolldown";
import { hashJobConfig } from "../core/configHash";
import {
  BUILD_DEFAULTS,
  resolveBuildEntry,
  rolldownInputOptions,
  type BuildEntryOptions,
} from "../core/rolldownConfig";
import { findInspectableTrainer } from "../core/trainerInspection";

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
  /**
   * Synchronous read of the most recent successful build's
   * `configHash`. Used by `/api/train` to capture the hash that's
   * about to be spawned so HMR routing on the *next* rebuild knows
   * whether the new bundle changed cloud-side config. `null` when the
   * watcher hasn't completed a successful build yet (e.g. fresh
   * scaffold) or the latest event was an `error`.
   */
  getCurrentConfigHash(): string | null;
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
 * loader returns the new module text rather than a stale evaluation.
 *
 * Walks every entry shape `runner.ts` accepts (named `arkor`, named
 * `trainer`, `default` Arkor manifest, `default.trainer`) via the
 * shared `findInspectableTrainer` helper — keeping inspection in sync
 * with execution. Without this, projects that only `export const
 * trainer` (a documented shortcut) would always produce `configHash:
 * null` and the SPA would unnecessarily SIGTERM-restart on every
 * rebuild.
 *
 * Best-effort: a missing/malformed manifest or a thrown user
 * constructor returns `null` and the caller treats the rebuild as
 * "config-unknown".
 */
async function inspectBundle(
  outFile: string,
): Promise<{ configHash: string; trainerName: string } | null> {
  try {
    const url = `${pathToFileURL(outFile).href}?t=${Date.now()}`;
    const mod = (await import(url)) as Record<string, unknown>;
    const inspection = findInspectableTrainer(mod);
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
  /**
   * When `startWatcher` runs against a project that doesn't have an
   * entry file yet, a poll timer takes over and waits for the file to
   * appear. Without this, an SPA that opened `/api/dev/events` against
   * a fresh scaffold would hang on the initial `error` event forever
   * — `startWatcher` is only re-entered on `subscribe()`, but EventSource
   * doesn't reconnect on application-level errors.
   */
  let entryWaitTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Monotonically incrementing build sequence number. Bumped on every
   * `BUNDLE_END` *before* the inspection awaits, so when an
   * inspection eventually resolves it can check whether a newer
   * build has started in the meantime and silently drop its stale
   * result.
   *
   * This matters because `inspectBundle` does an asynchronous
   * dynamic-import of the just-written artifact. Two rebuilds A → B
   * landing within the import window can race, with A's inspection
   * resolving *after* B's — the previous "fire-and-forget" code
   * would then publish A on top of B and leave `lastEvent` pointing
   * at the older `configHash`/`trainerName`. That in turn drove
   * `/api/dev/events` to make hot-swap-vs-restart decisions against
   * stale routing data and surfaced the wrong trainer name in the
   * SPA.
   */
  let buildSeq = 0;
  /**
   * Whether a `ready` event has actually broadcast yet. Tracked
   * separately from `firstBuild` because the inspection await means
   * the first BUNDLE_END's broadcast can land *after* a second
   * BUNDLE_END schedules its own — pinning the type to
   * "broadcast-time" rather than "schedule-time" guarantees the SPA
   * still sees `ready` first even when the initial inspection loses
   * the race.
   */
  let firstBroadcast = true;

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

  async function emitBuildSucceeded(): Promise<void> {
    if (disposed) return;
    const seq = ++buildSeq;
    const inspection = await inspectBundle(resolved.outFile);
    // Drop stale results: a newer rebuild already started (or
    // finished) while our inspection was running. The newer
    // inspection will own the broadcast for the latest state; this
    // one publishing now would just clobber `lastEvent` with the
    // older snapshot.
    if (seq !== buildSeq || disposed) return;
    const type: HmrEventType = firstBroadcast ? "ready" : "rebuild";
    firstBroadcast = false;
    broadcast({
      type,
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
      // Hand off to a low-frequency poll so an SPA already connected to
      // `/api/dev/events` transitions from "error" to "ready" the moment
      // the user creates the entry file — no manual reconnect required.
      // The poll is `unref()`'d so it never blocks process exit, and
      // `dispose()` clears it.
      if (!entryWaitTimer) {
        entryWaitTimer = setInterval(() => {
          if (disposed || watcher) {
            if (entryWaitTimer) clearInterval(entryWaitTimer);
            entryWaitTimer = null;
            return;
          }
          if (existsSync(resolved.entry)) {
            if (entryWaitTimer) clearInterval(entryWaitTimer);
            entryWaitTimer = null;
            startWatcher();
          }
        }, 1000);
        entryWaitTimer.unref?.();
      }
      return;
    }
    // The entry exists now — clear any leftover poll timer from a prior
    // failed startWatcher invocation.
    if (entryWaitTimer) {
      clearInterval(entryWaitTimer);
      entryWaitTimer = null;
    }
    watcher = watch({
      ...rolldownInputOptions(resolved),
      output: { file: resolved.outFile, format: "esm" },
    });
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_END") {
        // rolldown requires the per-build result to be closed to avoid leaks.
        event.result.close().catch(() => {});
        // The event type ("ready" vs "rebuild") is decided inside
        // `emitBuildSucceeded` *after* the inspection await, based on
        // whether any prior broadcast actually landed — see the
        // `firstBroadcast` comment for why pinning the type at this
        // schedule point would be wrong under inspection races.
        void emitBuildSucceeded();
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
    getCurrentConfigHash() {
      // `lastEvent` is `null` until the first BUNDLE_END (or null again
      // if the most recent emission was an `error`); both cases are
      // legitimate "we don't know the hash yet" signals to the caller.
      return lastEvent?.configHash ?? null;
    },
    async dispose() {
      disposed = true;
      subscribers.clear();
      if (entryWaitTimer) {
        clearInterval(entryWaitTimer);
        entryWaitTimer = null;
      }
      if (watcher) {
        const w = watcher;
        watcher = null;
        await w.close().catch(() => {});
      }
    },
  };
}
