import { hashJobConfig } from "./configHash";
import { moduleCacheBustUrl } from "./moduleCacheBust";
import { SIGNAL_EXIT_CODE } from "./signalExit";
import {
  findInspectableTrainer,
  getTrainerInspection,
  replaceTrainerCallbacks,
  requestTrainerEarlyStop,
} from "./trainerInspection";

import type { Trainer } from "./types";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const CALLBACK_RELOAD_SIGNAL = "SIGUSR2" as const;

/**
 * Shared no-op disposer returned when signal registration fails (e.g.
 * `process.on("SIGUSR2", ...)` throwing on a platform that doesn't
 * support the signal). Hoisted to module scope so it doesn't close
 * over anything and satisfies `unicorn/consistent-function-scoping`.
 */
const NO_OP_DISPOSE = (): void => undefined;

/**
 * Two-stage shutdown handling so HMR rebuilds (Studio sends SIGTERM)
 * preserve the in-flight checkpoint work:
 *
 *   - 1st signal → `trainer.requestEarlyStop()`. The trainer keeps
 *     running, lets the next `checkpoint.saved` event land, then issues
 *     `cancel()`.
 *   - 2nd signal → immediate `process.exit(POSIX 128+signo)`:
 *     130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP. Escape hatch
 *     for an impatient operator or a hung early-stop. Per-signal
 *     exit code so parent shells see the actual interruption type.
 *
 * The returned dispose function removes the handlers so a normal
 * `wait()` completion doesn't leave stale listeners behind: important
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
      // signal-aware orchestration. `SIGNAL_EXIT_CODE` is keyed by the
      // exact `SHUTDOWN_SIGNALS` union, so the lookup is always defined
      // (a new signal added to the tuple without a code would fail the
      // Record literal's exhaustiveness check at compile time).
      const code = SIGNAL_EXIT_CODE[signal];
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
    //
    // Track whether the early-stop chain rejected so the final
    // `process.exit` carries a non-zero status. The previous version
    // always exited 0, which made `arkor start || cleanup_on_failure`
    // wrappers classify a cancel-POST rejection (cloud-api transient
    // failure, network drop) as a clean run despite the stderr
    // diagnostic. POSIX 128 + signo on failure mirrors the
    // second-signal exit-code convention so parent shells see a
    // signal-style nonzero status.
    let earlyStopFailed = false;
    void requestTrainerEarlyStop(trainer)
      .catch((err: unknown) => {
        earlyStopFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`requestEarlyStop failed: ${msg}\n`);
      })
      .finally(() => {
        // Success exits 0 ONLY for SIGTERM (Codex P2, round 82).
        // SIGTERM is the Studio HMR restart path: the SPA parses the
        // train stream's `exit=` marker and suppresses auto-restart
        // on any nonzero code, so a graceful early-stop MUST read as
        // 0 there for the restart flow to work. SIGINT / SIGHUP are
        // operator interrupts (Ctrl-C on a direct `arkor start`,
        // hangup): even when the early-stop + cancel succeeded, the
        // run was still user-aborted, and exiting 0 would make
        // `arkor start || cleanup_on_failure` wrappers classify the
        // abort as a clean completion. Those keep the conventional
        // POSIX 128 + signo (130 / 129) on success too; any failed
        // early-stop exits 128 + signo regardless of signal.
        const code =
          earlyStopFailed || signal !== "SIGTERM"
            ? SIGNAL_EXIT_CODE[signal]
            : 0;
        process.exit(code);
      });
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
 * training run is untouched; only the in-process callbacks change.
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
   * Config hash of the trainer THIS process is actually running,
   * computed once at install time from the live trainer's inspection
   * brand. Each SIGUSR2 reload compares the re-imported bundle's
   * hash against it and skips the swap on mismatch (Codex P2, round
   * 82): the server classifies "hot-swappable" against the artefact
   * it inspected, but signal delivery is asynchronous, and a second
   * config-CHANGING save can rename a newer artefact into place
   * before this handler's import runs. Without the child-side gate,
   * that import would install the newer trainer's callbacks into a
   * cloud job still running the old config, violating the hash
   * gate's guarantee for the window until the follow-up SIGTERM
   * lands. `null` for unbranded (hand-rolled) trainers, where
   * `replaceTrainerCallbacks` is a documented no-op anyway; the gate
   * then stays open rather than blocking a swap that can't happen.
   */
  const baselineInspection = getTrainerInspection(trainer);
  let baselineConfigHash: string | null = null;
  if (baselineInspection) {
    try {
      baselineConfigHash = hashJobConfig(baselineInspection.config);
    } catch {
      // Unhashable config (pathological toJSON, cycles): leave the
      // baseline null. The server-side gate can't have classified a
      // hot-swap against a hash it couldn't compute either, so a
      // SIGUSR2 arriving anyway is best-effort territory.
    }
  }
  /**
   * Monotonic counter for sequencing concurrent SIGUSR2 reloads.
   * Bumped synchronously inside the signal handler *before* the
   * dynamic-import await begins, so each in-flight reload knows its
   * arrival order. When the import resolves, the IIFE compares its
   * captured `seq` against `loadSeq` and silently drops the result
   * if a newer signal already started a newer reload. Without this,
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
    // Content-hash cache-bust (vs `Date.now()`): Node's ESM
    // loader never evicts module records, so a long `arkor start`
    // session with frequent SIGUSR2 reloads would accumulate one
    // record per signal forever. Keying on the actual artefact bytes
    // (via `moduleCacheBustUrl`) collapses no-op signals onto the
    // same URL; the leak is bounded to "one per real edit", which
    // is fundamentally what HMR has to retain.
    const url = moduleCacheBustUrl(entryPath);
    void (async () => {
      try {
        const mod = (await import(url)) as Record<string, unknown>;
        // A newer SIGUSR2 already started its own import while we
        // were awaiting; drop our result so the latest edit wins.
        if (seq !== loadSeq) return;
        // Delegate the entry-shape walk to `findInspectableTrainer`
        // so SIGUSR2's view of "what counts as a trainer" stays
        // identical to the HMR coordinator's `inspectBundle` and
        // `runner.ts`'s `extractTrainer`.
        const inspection = findInspectableTrainer(mod);
        if (!inspection) {
          process.stderr.write(
            "Callback reload skipped: rebuilt bundle has no inspectable trainer.\n",
          );
          return;
        }
        // Child-side config gate (see `baselineConfigHash` above):
        // only install callbacks from a bundle whose `JobConfig`
        // matches the config this process actually spawned with.
        // The artefact on disk can already be a NEWER,
        // config-changing build than the one the server classified
        // as hot-swappable; installing its callbacks here would run
        // them against a cloud job with a different config until
        // the follow-up SIGTERM restart lands. An unhashable
        // reloaded config counts as a mismatch (can't prove
        // equality → don't swap).
        if (baselineConfigHash !== null) {
          let reloadedConfigHash: string | null = null;
          try {
            reloadedConfigHash = hashJobConfig(inspection.config);
          } catch {
            // fall through with null → mismatch below
          }
          if (reloadedConfigHash !== baselineConfigHash) {
            process.stderr.write(
              "Callback reload skipped: rebuilt bundle's config differs from the running job's; waiting for the restart signal.\n",
            );
            return;
          }
        }
        replaceTrainerCallbacks(trainer, inspection.callbacks);
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
  // listener here is the documented contract on those platforms:
  // quietly degrade to a no-op disposer rather than crashing
  // `arkor start` at boot. When `process.on` throws we return the
  // shared `NO_OP_DISPOSE` so the caller's `runTrainer` finally
  // block never tries to `process.off(...)` a handler that was
  // never attached; the success path's disposer is only ever
  // created after the registration succeeds, so it can off()
  // unconditionally.
  try {
    process.on(CALLBACK_RELOAD_SIGNAL, handler);
  } catch {
    return NO_OP_DISPOSE;
  }
  return () => {
    process.off(CALLBACK_RELOAD_SIGNAL, handler);
  };
}
