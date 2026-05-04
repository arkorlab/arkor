const TERMINATING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface CleanupHookOptions {
  /**
   * Idempotent cleanup body. Wrapped with a `done` guard so a noisy
   * shutdown (signal arriving while `process.exit` is already running
   * an `exit` listener) doesn't trigger a double-cleanup. May be sync
   * or return a Promise; async cleanups are awaited (across **all
   * registered hooks**) before `exitOnSignal` fires the final
   * `process.exit`.
   */
  cleanup: () => void | Promise<void>;
  /**
   * Whether the signal-handler arm of this registration should call
   * `process.exit(0)` once every in-flight cleanup (this hook + any
   * siblings registered in the same process) has settled. Use `true`
   * for the outermost cleanup responsible for terminating the
   * process; `false` for inner cleanups that should let a sibling
   * own the exit. Default: `false`.
   */
  exitOnSignal?: boolean;
}

/**
 * Module-scoped tracker of cleanup promises that haven't settled yet.
 * The exit-owning hook waits on the union of (its own cleanup) +
 * (every other in-flight cleanup) before calling `process.exit(0)`,
 * so a fire-and-forget async cleanup in a sibling registration —
 * `hmr.dispose()` is the canonical example — isn't cut off by an
 * eager exit.
 *
 * Auto-prunes via the `.finally(() => inFlightCleanups.delete(...))`
 * each `run()` attaches, so the set doesn't grow without bound across
 * multiple `runDev()` invocations in the same process (tests).
 */
const inFlightCleanups = new Set<Promise<void>>();

/**
 * Register a cleanup hook that fires on `process.exit` and on
 * SIGINT / SIGTERM / SIGHUP. Used by `runDev` to dispose long-lived
 * resources (the studio-token file, the HMR coordinator) without each
 * call site re-implementing the same idempotent-guard + per-signal
 * registration boilerplate.
 *
 * Per-registration signal listeners (rather than a singleton): each
 * `runDev()` invocation gets its own listener wired to its own
 * `done` latch. This matches the old behaviour and keeps test
 * isolation simple (vitest's per-test cleanup doesn't have to reach
 * into module state).
 *
 * `process.on("exit", ...)` listeners cannot be async — Node fires
 * them right before the process terminates and discards any returned
 * promise. We still register so sync cleanups (e.g. `unlinkSync`) run
 * on a normal `process.exit(0)` path that never reached a signal
 * handler. Async tails on this path are best-effort. The signal-
 * handler path *does* await async tails before exiting.
 */
export function registerCleanupHook(options: CleanupHookOptions): void {
  let done = false;
  const run = (): Promise<void> => {
    if (done) return Promise.resolve();
    done = true;
    let promise: Promise<void>;
    try {
      const result = options.cleanup();
      // Wrap so callers can await uniformly even when cleanup was
      // synchronous. Catch is attached so a thrown async cleanup
      // doesn't leave an unhandled rejection on the floor.
      promise = Promise.resolve(result).catch(() => {
        // best-effort: shutdown is racing other cleanup paths
      });
    } catch {
      promise = Promise.resolve();
    }
    inFlightCleanups.add(promise);
    void promise.finally(() => inFlightCleanups.delete(promise));
    return promise;
  };

  process.on("exit", () => {
    void run();
  });

  for (const sig of TERMINATING_SIGNALS) {
    process.on(sig, () => {
      // Sync cleanup body fires inside this `run()` call before the
      // returned promise resolves; that preserves "side effect is
      // observable right after the handler returns" for sync
      // cleanups like `unlinkSync` (and the existing tests that
      // assert on it).
      const my = run();
      if (!options.exitOnSignal) return;
      // Wait for THIS hook's tail and every other in-flight cleanup
      // (siblings registered in the same process) before exiting.
      // Settled promises pass through Promise.allSettled in a single
      // microtask, so a process whose hooks are all synchronous
      // exits effectively immediately.
      void Promise.allSettled([
        my,
        ...inFlightCleanups,
      ]).then(() => process.exit(0));
    });
  }
}
