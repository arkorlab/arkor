import type { ChildProcess } from "node:child_process";

/**
 * Per-active-train state tracked alongside the spawned `arkor start`
 * subprocess. The Studio server records this at spawn time so HMR
 * rebuilds can decide, per child, between:
 *
 *   - **SIGUSR2** (callback hot-swap) when the new bundle's `configHash`
 *     matches the one captured at spawn time — the cloud-side run is
 *     unaffected, only in-process callbacks need to update.
 *   - **SIGTERM** (graceful early-stop + restart) when the configs
 *     diverge — the runner's internal early-stop entry point lets the
 *     next checkpoint finish, the subprocess exits, and the SPA
 *     re-spawns with the rebuilt artefact.
 */
export interface ActiveTrain {
  child: ChildProcess;
  trainFile?: string;
  /** Cloud-side config hash captured at spawn time (may be null if the
   *  manifest wasn't inspectable yet — e.g. spawn raced an in-flight
   *  build). A null entry forces SIGTERM on the next rebuild because we
   *  can't prove the configs match. */
  configHash: string | null;
  /**
   * `true` once we've already SIGTERM'd this child for an HMR-driven
   * early-stop. Subsequent rebuilds (which can land before the child
   * has reached its next checkpoint) must NOT re-send SIGTERM —
   * the runner's shutdown handler treats a second SIGTERM as the
   * emergency `process.exit(143)` escape hatch, which would defeat
   * the whole point of preserving the in-flight checkpoint. Kept
   * internal to the registry; consumers shouldn't manage it.
   */
  earlyStopRequested?: boolean;
}

export interface RestartTarget {
  pid: number;
  trainFile?: string;
}

export interface DispatchResult {
  /** Children whose callbacks were rotated in place via SIGUSR2. */
  hotSwapTargets: RestartTarget[];
  /**
   * Children that were SIGTERM'd for graceful early-stop and need to
   * be re-spawned by the SPA after the train stream emits its
   * `exit=...` line. Includes both config-mismatch matches and
   * config-match cases that fell back here because the platform
   * doesn't support SIGUSR2 (Windows).
   */
  restartTargets: RestartTarget[];
}

/**
 * Outcome of a single `child.kill(signal)` call.
 *
 * - `"ok"`: signal was delivered.
 * - `"gone"`: process was already exited. Surfaces both as `kill`
 *   returning `false` (Node's mapped form) and as a thrown `ESRCH`
 *   (a race where the child exits between the `entries` lookup and
 *   the `kill` call — POSIX `kill(2)` raises `ESRCH` for
 *   non-existent PIDs and Node propagates it on some versions).
 * - `"unsupported"`: any *other* `kill` throw — i.e. the signal
 *   couldn't be delivered for a reason that isn't "process is gone".
 *   The motivating case is the platform not supporting this signal
 *   kind (Windows + `SIGUSR2` → `ENOSYS`; bad signal name →
 *   `EINVAL`), which `dispatchRebuild` falls back to SIGTERM-restart
 *   for. The bucket is intentionally a catch-all rather than a
 *   whitelist of error codes: rare cases like `EPERM` (lost the
 *   right to signal a re-parented child) and platform-specific
 *   surprises take the same conservative fallback — try the next
 *   signal, otherwise drop the entry — which is what callers want
 *   from "kill failed for some non-recoverable reason".
 */
type KillResult = "ok" | "gone" | "unsupported";

function safeKill(child: ChildProcess, signal: NodeJS.Signals): KillResult {
  try {
    return child.kill(signal) ? "ok" : "gone";
  } catch (err) {
    // `ESRCH` ("no such process") means the child already exited —
    // semantically identical to `kill returning false`. Mis-classifying
    // it as `"unsupported"` would route a hash-match hot-swap candidate
    // into the SIGTERM fallback, which then also no-ops (also gone) but
    // costs a needless restart-bucket inclusion until the close handler
    // unregisters the child. Every other throw collapses into
    // `"unsupported"` per the type doc above.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") return "gone";
    return "unsupported";
  }
}

/**
 * Encapsulates the set of `/api/train`-spawned subprocesses and the
 * signal-dispatch decision rule for HMR rebuilds. Pulled out of
 * `buildStudioApp` so the policy is testable in isolation and so future
 * additions (e.g. a `cancel-all` admin endpoint) have a clear seam.
 */
export class TrainRegistry {
  private readonly entries = new Map<number, ActiveTrain>();

  register(
    child: ChildProcess,
    init: Omit<ActiveTrain, "child" | "earlyStopRequested">,
  ): void {
    if (typeof child.pid !== "number") return;
    this.entries.set(child.pid, {
      child,
      ...init,
      earlyStopRequested: false,
    });
  }

  unregister(pid: number | undefined): void {
    if (typeof pid === "number") this.entries.delete(pid);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read-only snapshot, mostly for tests / observability. */
  list(): ReadonlyArray<ActiveTrain> {
    return [...this.entries.values()];
  }

  /**
   * Single entry point for HMR rebuilds: per active child, decide
   * between callback hot-swap (SIGUSR2) and graceful restart
   * (SIGTERM), apply the signal, and report which children landed in
   * each bucket so the SPA can update its UI / re-spawn restarted
   * runs.
   *
   * Combines what was previously `notifyCallbackReload` +
   * `requestEarlyStopOnMismatch` into one pass so the per-child
   * decision is atomic — important because the hot-swap path can
   * gracefully degrade into the restart path on platforms (Windows)
   * where SIGUSR2 isn't supported, which is hard to express across
   * two separate iterations of the registry.
   *
   * Re-signal protection: children already flagged
   * `earlyStopRequested` are skipped entirely. The flag is cleared
   * naturally when the child exits and is unregistered.
   *
   * Defensive corner cases:
   *   - `kill()` returns `false` (process already exited) → drop
   *     from the targets list, the registry's close handler will
   *     unregister it.
   *   - `kill("SIGUSR2")` throws on Windows → degrade to SIGTERM so
   *     callback edits still take effect (via a full restart) rather
   *     than silently being ignored.
   */
  dispatchRebuild(nextConfigHash: string | null): DispatchResult {
    const hotSwapTargets: RestartTarget[] = [];
    const restartTargets: RestartTarget[] = [];

    for (const [pid, entry] of this.entries) {
      if (entry.earlyStopRequested) continue;
      const target: RestartTarget = { pid, trainFile: entry.trainFile };
      const matches =
        nextConfigHash !== null &&
        entry.configHash !== null &&
        entry.configHash === nextConfigHash;

      if (matches) {
        const r = safeKill(entry.child, "SIGUSR2");
        if (r === "ok") {
          hotSwapTargets.push(target);
          continue;
        }
        if (r === "gone") {
          // Child already exited; close handler will unregister.
          continue;
        }
        // Windows fallback: SIGUSR2 isn't supported on win32 — degrade
        // to a full restart so callback edits don't silently fail to
        // apply. The user-visible result (callbacks reload after a
        // brief restart) matches the design intent.
        const fallback = safeKill(entry.child, "SIGTERM");
        if (fallback === "ok") {
          entry.earlyStopRequested = true;
          restartTargets.push(target);
        }
        // "gone" / "unsupported" again → drop silently; the close
        // handler (or operator-driven restart) will recover.
        continue;
      }

      // Hash mismatch (or one side is null): graceful restart.
      const r = safeKill(entry.child, "SIGTERM");
      if (r === "ok") {
        entry.earlyStopRequested = true;
        restartTargets.push(target);
      }
      // "gone": child already exited, drop. "unsupported": can't
      // happen for SIGTERM on supported platforms; drop defensively.
    }

    return { hotSwapTargets, restartTargets };
  }
}
