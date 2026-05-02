const TERMINATING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface CleanupHookOptions {
  /**
   * Idempotent cleanup body. Wrapped with a `done` guard so a noisy
   * shutdown (signal arriving while `process.exit` is already running an
   * `exit` listener) doesn't trigger a double-cleanup.
   */
  cleanup: () => void | Promise<void>;
  /**
   * Whether the signal-handler arm of the registration should also call
   * `process.exit(0)` after cleanup. Use `true` for the outermost
   * cleanup responsible for terminating the process; `false` for inner
   * cleanups that should pass control through to a sibling exit
   * handler. Default: `false`.
   */
  exitOnSignal?: boolean;
}

/**
 * Register a cleanup hook that fires on `process.exit` and on
 * SIGINT / SIGTERM / SIGHUP. Used by `runDev` to dispose long-lived
 * resources (the studio-token file, the HMR coordinator) without each
 * call site re-implementing the same idempotent-guard + per-signal
 * registration boilerplate.
 *
 * Registration order matters: Node fires listeners in the order they
 * were attached, so the *first* `registerCleanupHook` call gets to run
 * before subsequent ones. The Studio dev launcher relies on this to
 * guarantee that "tear down HMR" lands before "remove studio-token".
 */
export function registerCleanupHook(options: CleanupHookOptions): void {
  let done = false;
  // Synchronous wrapper so signal handlers preserve "cleanup landed
  // before this function returns" — important for sync cleanups (e.g.
  // `unlinkSync`) and for tests that assert the side effect right after
  // invoking the handler. Async cleanups are fire-and-forget with a
  // catch so a hung dispose doesn't block exit.
  const run = (): void => {
    if (done) return;
    done = true;
    try {
      const result = options.cleanup();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          // best-effort: shutdown is racing other cleanup paths
        });
      }
    } catch {
      // best-effort
    }
  };

  process.on("exit", run);

  for (const sig of TERMINATING_SIGNALS) {
    process.on(sig, () => {
      run();
      if (options.exitOnSignal) process.exit(0);
    });
  }
}
