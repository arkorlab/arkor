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
 *     diverge — `Trainer.requestEarlyStop` lets the next checkpoint
 *     finish, the subprocess exits, and the SPA re-spawns with the
 *     rebuilt artefact.
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
   * Send a callback hot-swap signal (SIGUSR2) to every child whose
   * stored `configHash` matches `nextConfigHash`. The child's runner
   * (`installCallbackReloadHandler`) re-imports the rebuilt bundle and
   * calls `Trainer.replaceCallbacks`. Returns the list of children
   * actually signalled, so the SSE event payload can include them for
   * SPA-side telemetry.
   */
  notifyCallbackReload(
    nextConfigHash: string | null,
  ): Array<{ pid: number; trainFile?: string }> {
    if (nextConfigHash === null) return [];
    const signalled: Array<{ pid: number; trainFile?: string }> = [];
    for (const [pid, entry] of this.entries) {
      if (entry.configHash !== null && entry.configHash === nextConfigHash) {
        try {
          entry.child.kill("SIGUSR2");
          signalled.push({ pid, trainFile: entry.trainFile });
        } catch {
          // child may have just exited; the close handler will clean
          // up the entry on its own.
        }
      }
    }
    return signalled;
  }

  /**
   * Send a graceful early-stop signal (SIGTERM) to every child whose
   * stored `configHash` differs from `nextConfigHash` AND that hasn't
   * already been signalled. The child's runner
   * (`installShutdownHandlers`) calls the trainer's internal
   * early-stop entry point which preserves the in-flight checkpoint
   * before exiting. Returns the list of children we actually
   * signalled this call so the SPA can re-spawn them with the new
   * bundle.
   *
   * If `nextConfigHash` is null (the new bundle has no inspectable
   * trainer), every active not-yet-signalled child is SIGTERM'd
   * defensively — we can't prove their configs are unaffected.
   *
   * Re-signal protection: a second SIGTERM hits the runner's
   * emergency `exit(143)` fast-path and would defeat checkpoint
   * preservation. Children flagged `earlyStopRequested` here are
   * skipped on subsequent rebuilds; the entry is removed from the
   * registry when the child exits, so the next spawn starts from a
   * clean slate.
   */
  requestEarlyStopOnMismatch(
    nextConfigHash: string | null,
  ): RestartTarget[] {
    const targets: RestartTarget[] = [];
    for (const [pid, entry] of this.entries) {
      if (entry.earlyStopRequested) continue;
      if (
        nextConfigHash === null ||
        entry.configHash === null ||
        entry.configHash !== nextConfigHash
      ) {
        try {
          entry.child.kill("SIGTERM");
          entry.earlyStopRequested = true;
          // Push only after a successful kill; a thrown `kill` means
          // the child has already exited and is not a real restart
          // target (the SPA would otherwise wait forever for an
          // exit message that never comes).
          targets.push({ pid, trainFile: entry.trainFile });
        } catch {
          // child already exited; close handler will clean up.
        }
      }
    }
    return targets;
  }
}
