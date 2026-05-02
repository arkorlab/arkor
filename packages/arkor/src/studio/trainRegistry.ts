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

  register(child: ChildProcess, init: Omit<ActiveTrain, "child">): void {
    if (typeof child.pid !== "number") return;
    this.entries.set(child.pid, { child, ...init });
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
   * stored `configHash` differs from `nextConfigHash`. The child's
   * runner (`installShutdownHandlers`) calls `Trainer.requestEarlyStop`
   * which preserves the in-flight checkpoint before exiting. Returns
   * the list of children signalled so the SPA can re-spawn them with
   * the new bundle.
   *
   * If `nextConfigHash` is null (the new bundle has no inspectable
   * trainer), every active child is SIGTERM'd defensively — we can't
   * prove their configs are unaffected.
   */
  requestEarlyStopOnMismatch(
    nextConfigHash: string | null,
  ): RestartTarget[] {
    const targets: RestartTarget[] = [];
    for (const [pid, entry] of this.entries) {
      if (
        nextConfigHash === null ||
        entry.configHash === null ||
        entry.configHash !== nextConfigHash
      ) {
        try {
          entry.child.kill("SIGTERM");
        } catch {
          // child already exited; close handler will clean up.
        }
        targets.push({ pid, trainFile: entry.trainFile });
      }
    }
    return targets;
  }
}
