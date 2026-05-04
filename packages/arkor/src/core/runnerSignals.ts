import { pathToFileURL } from "node:url";
import {
  findInspectableTrainer,
  replaceTrainerCallbacks,
  requestTrainerEarlyStop,
} from "./trainerInspection";
import type { Trainer, TrainerCallbacks } from "./types";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const CALLBACK_RELOAD_SIGNAL = "SIGUSR2" as const;

/**
 * Two-stage shutdown handling so HMR rebuilds (Studio sends SIGTERM)
 * preserve the in-flight checkpoint work:
 *
 *   - 1st signal → `trainer.requestEarlyStop()`. The trainer keeps
 *     running, lets the next `checkpoint.saved` event land, then issues
 *     `cancel()`.
 *   - 2nd signal → immediate `process.exit(143)`. Escape hatch for an
 *     impatient operator or a hung early-stop.
 *
 * The returned dispose function removes the handlers so a normal
 * `wait()` completion doesn't leave stale listeners behind — important
 * because `runTrainer` can be called multiple times in tests within a
 * single Node process.
 */
export function installShutdownHandlers(trainer: Trainer): () => void {
  let signalCount = 0;
  const handler = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount > 1) {
      process.stdout.write(
        `Received second ${signal}; exiting without waiting for checkpoint.\n`,
      );
      process.exit(143);
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
    // `createTrainer`. The runner only reaches this handler with a
    // discovered SDK trainer, so the brand is guaranteed to be present.
    requestTrainerEarlyStop(trainer)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`requestEarlyStop failed: ${msg}\n`);
      })
      .finally(() => process.exit(0));
  };
  for (const sig of SHUTDOWN_SIGNALS) process.on(sig, handler);
  return () => {
    for (const sig of SHUTDOWN_SIGNALS) process.off(sig, handler);
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
  const handler = (): void => {
    const url = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
    void (async () => {
      try {
        const mod = (await import(url)) as Record<string, unknown>;
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
  process.on(CALLBACK_RELOAD_SIGNAL, handler);
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
