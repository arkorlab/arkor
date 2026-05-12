import { moduleCacheBustUrl } from "./moduleCacheBust";
import {
  findInspectableTrainer,
  replaceTrainerCallbacks,
  requestTrainerEarlyStop,
} from "./trainerInspection";
import type { Trainer, TrainerCallbacks } from "./types";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const CALLBACK_RELOAD_SIGNAL = "SIGUSR2" as const;

/**
 * POSIX-style exit code for a signal-terminated process: `128 + signo`.
 * Used by the second-signal emergency-exit path so the runner's exit
 * status reflects which signal actually fired (Ctrl-C vs SIGTERM vs
 * SIGHUP), not a single hardcoded 143. Mirrors the SIGNAL_EXIT_CODE
 * map in `cli/cleanupHooks.ts`. Parent shells / orchestrators / CI
 * runners distinguish "user interrupted" by signo on POSIX.
 */
const SECOND_SIGNAL_EXIT_CODE: Record<
  (typeof SHUTDOWN_SIGNALS)[number],
  number
> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Two-stage shutdown handling so HMR rebuilds (Studio sends SIGTERM)
 * preserve the in-flight checkpoint work:
 *
 *   - 1st signal → `trainer.requestEarlyStop()`. The trainer keeps
 *     running, lets the next `checkpoint.saved` event land, then issues
 *     `cancel()`.
 *   - 2nd signal → immediate `process.exit(POSIX 128+signo)` —
 *     130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP. Escape hatch
 *     for an impatient operator or a hung early-stop. Per-signal
 *     exit code so parent shells see the actual interruption type.
 *
 * The returned dispose function removes the handlers so a normal
 * `wait()` completion doesn't leave stale listeners behind — important
 * because `runTrainer` can be called multiple times in tests within a
 * single Node process.
 */
export function installShutdownHandlers(trainer: Trainer): () => void {
  let signalCount = 0;
  const handler = (signal: (typeof SHUTDOWN_SIGNALS)[number]): void => {
    signalCount += 1;
    if (signalCount > 1) {
      process.stdout.write(
        `Received second ${signal}; exiting without waiting for checkpoint.\n`,
      );
      // POSIX 128 + signo so the parent shell sees the right exit
      // status: 130 for SIGINT (Ctrl-C twice), 129 for SIGHUP,
      // 143 for SIGTERM. Hardcoding 143 misclassifies SIGINT and
      // SIGHUP shutdowns as SIGTERM-style exits and breaks
      // signal-aware orchestration. Defaults to 143 for any future
      // signal we forget to map.
      const code = SECOND_SIGNAL_EXIT_CODE[signal] ?? 143;
      process.exit(code);
      // Explicit return so test mocks of process.exit (which don't
      // actually terminate the worker) don't fall through into the
      // early-stop path.
      return;
    }
    process.stdout.write(
      `Received ${signal}; early-stopping at next checkpoint…\n`,
    );
    // Drive the trainer's internal early-stop entry point via the
    // `Symbol.for("arkor.trainer.requestEarlyStop")` brand attached by
    // `createTrainer`. `runTrainer` also accepts hand-rolled
    // `{ start, wait, cancel }` trainers; for those the brand is
    // absent and `requestTrainerEarlyStop` transparently falls back
    // to `trainer.cancel()` (best-effort, matches the public contract).
    requestTrainerEarlyStop(trainer)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`requestEarlyStop failed: ${msg}\n`);
      })
      .finally(() => process.exit(0));
  };
  // Per-signal closure (vs a single shared listener registered on
  // every signal): the closure captures `sig` at registration time
  // so the handler doesn't depend on whatever Node passes as the
  // event arg. Node's documented contract is to pass the signal
  // name, but pinning the source via closure keeps the handler
  // robust regardless and makes the registration → arg
  // relationship explicit at the callsite. Stored in a Map so
  // `process.off` can remove the exact closure (anonymous arrow
  // would leak the listener since `process.off` matches by
  // identity).
  const signalHandlers = new Map<
    (typeof SHUTDOWN_SIGNALS)[number],
    () => void
  >();
  for (const sig of SHUTDOWN_SIGNALS) {
    const fn = () => handler(sig);
    signalHandlers.set(sig, fn);
    process.on(sig, fn);
  }
  return () => {
    for (const [sig, fn] of signalHandlers) process.off(sig, fn);
  };
}

/**
 * SIGUSR2 handler: re-import the freshly-rebuilt artefact and rotate
 * the trainer's callback cell via the internal
 * `Symbol.for("arkor.trainer.replaceCallbacks")` brand. The cloud-side
 * training run is untouched — only the in-process callbacks change.
 *
 * Studio sends SIGUSR2 from the `/api/dev/events` HMR pipeline when
 * (and only when) the rebuilt bundle's `JobConfig` hash matches the
 * one captured at spawn time. A mismatch produces SIGTERM instead, which
 * goes through `installShutdownHandlers` above.
 */
export function installCallbackReloadHandler(
  trainer: Trainer,
  entryPath: string,
): () => void {
  /**
   * Monotonic counter for sequencing concurrent SIGUSR2 reloads.
   * Bumped synchronously inside the signal handler *before* the
   * dynamic-import await begins, so each in-flight reload knows its
   * arrival order. When the import resolves, the IIFE compares its
   * captured `seq` against `loadSeq` and silently drops the result
   * if a newer signal already started a newer reload — without this,
   * two same-`configHash` rebuilds firing back-to-back can race on
   * the import: the earlier import's bytes (now stale on disk)
   * resolve *after* the newer one, and `replaceTrainerCallbacks`
   * overwrites the freshly-loaded callbacks with the prior version,
   * leaving the running job out of sync until the next rebuild.
   * Mirrors the `buildSeq` guard in `studio/hmr.ts`'s
   * `emitBuildSucceeded`.
   */
  let loadSeq = 0;
  const handler = (): void => {
    const seq = ++loadSeq;
    // mtime+ctime+size cache-bust (vs `Date.now()`): Node's ESM
    // loader never evicts module records, so a long `arkor start`
    // session with frequent SIGUSR2 reloads would accumulate one
    // record per signal forever. Keying on the actual artefact bytes
    // (via `moduleCacheBustUrl`) collapses no-op signals onto the
    // same URL — the leak is bounded to "one per real edit", which
    // is fundamentally what HMR has to retain.
    const url = moduleCacheBustUrl(entryPath);
    void (async () => {
      try {
        const mod = (await import(url)) as Record<string, unknown>;
        // A newer SIGUSR2 already started its own import while we
        // were awaiting; drop our result so the latest edit wins.
        if (seq !== loadSeq) return;
        const callbacks = extractCallbacks(mod);
        if (!callbacks) {
          process.stderr.write(
            "Callback reload skipped: rebuilt bundle has no inspectable trainer.\n",
          );
          return;
        }
        replaceTrainerCallbacks(trainer, callbacks);
        process.stdout.write(
          "Callbacks hot-reloaded; training run continues.\n",
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Callback reload failed: ${msg}\n`);
      }
    })();
  };
  // `process.on('SIGUSR2', ...)` can throw at registration time on
  // platforms that don't support the signal (notably Windows: libuv's
  // signal-wrap returns ENOSYS for SIGUSR2 on win32 and the error
  // escapes to userland on some Node versions). The server-side
  // `trainRegistry.safeKill(child, "SIGUSR2")` already detects this
  // ("unsupported" → falls back to SIGTERM-restart), so an unarmed
  // listener here is the documented contract on those platforms —
  // quietly degrade to a no-op disposer rather than crashing
  // `arkor start` at boot.
  try {
    process.on(CALLBACK_RELOAD_SIGNAL, handler);
  } catch {
    return () => {
      // no-op: handler was never attached
    };
  }
  return () => {
    process.off(CALLBACK_RELOAD_SIGNAL, handler);
  };
}

/**
 * Extract the user-supplied callbacks reference from a re-imported
 * bundle. Delegates the entry-shape walk to `findInspectableTrainer`
 * so SIGUSR2's view of "what counts as a trainer" stays identical to
 * the HMR coordinator's `inspectBundle` and `runner.ts`'s
 * `extractTrainer`. Returns `null` when no candidate carries the
 * inspection brand.
 */
function extractCallbacks(
  mod: Record<string, unknown>,
): Partial<TrainerCallbacks> | null {
  return findInspectableTrainer(mod)?.callbacks ?? null;
}
