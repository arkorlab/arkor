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
   * Fingerprint (mtime+ctime+size, see `core/moduleCacheBust.ts`) of
   * the on-disk `.arkor/build/index.mjs` at spawn time. Used **only**
   * to gate the pre-ready-spawn backfill: if a rebuild eventually
   * fires while `configHash` is still null and this fingerprint
   * matches the rebuild's artefact, the child is provably reading
   * the same bundle bytes the new hash describes — safe to backfill
   * `configHash` and skip dispatch. A mismatch (or null here) means
   * the on-disk artefact has changed between spawn and rebuild
   * (user edited mid-spawn, fresh project never built, …) so the
   * child is running stale bytes and we MUST SIGTERM-restart to
   * keep cloud-side `JobConfig` aligned with what the child
   * actually loaded. Null when HMR isn't enabled or stat failed.
   */
  spawnArtifactHash: string | null;
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
  /**
   * Cloud-side job id, captured by parsing the runner's
   * `Started job <id>` stdout line shortly after spawn. Populated
   * via `recordJobId(pid, id)` on the first matching chunk; null
   * before that or for runs whose stdout we never saw the line on
   * (early spawn failure, custom user bins, etc.). The
   * `/api/train` cancel handler reads this to fire a fire-and-forget
   * `POST /v1/jobs/:id/cancel` before SIGKILLing the subprocess —
   * SIGKILL bypasses the runner's `installShutdownHandlers`, so
   * without this server-side cancel the cloud-side job would live
   * until the cloud reaper / TTL fires (continued GPU spend).
   */
  jobId: string | null;
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
    init: Omit<
      ActiveTrain,
      "child" | "earlyStopRequested" | "spawnArtifactHash" | "jobId"
    > & {
      // Optional in the signature so tests / future callers that
      // don't track the on-disk artefact fingerprint (e.g. an HMR-
      // disabled server, a hand-rolled fake) can omit it. Defaults
      // to `null`, which forces the pre-ready-spawn branch to fall
      // through to SIGTERM-restart on the next non-null rebuild —
      // the safe choice when we genuinely don't know what bytes
      // the child loaded. Real `/api/train` calls in HMR mode
      // capture this from `coordinator.getCurrentArtifactHash()`.
      spawnArtifactHash?: string | null;
    },
  ): void {
    if (typeof child.pid !== "number") return;
    this.entries.set(child.pid, {
      child,
      ...init,
      spawnArtifactHash: init.spawnArtifactHash ?? null,
      earlyStopRequested: false,
      // `jobId` starts null — populated later by `recordJobId(pid,
      // id)` when the server's stdout parser sees the runner's
      // `Started job <id>` line. Tests that don't exercise the
      // cancel-POST path can leave it null.
      jobId: null,
    });
  }

  unregister(pid: number | undefined): void {
    if (typeof pid === "number") this.entries.delete(pid);
  }

  /**
   * Record the cloud-side job id for an active child. Called by the
   * server's `/api/train` stdout parser the first time it spots
   * `Started job <id>` in the runner's output. Idempotent: a
   * second call with the same pid + id is a no-op (the runner
   * only prints the line once anyway). Unknown pids are silently
   * dropped (the child may have already exited and unregistered).
   */
  recordJobId(pid: number | undefined, jobId: string): void {
    if (typeof pid !== "number") return;
    const entry = this.entries.get(pid);
    if (!entry) return;
    entry.jobId = jobId;
  }

  /**
   * Read the recorded cloud-side job id for a pid. `/api/train`'s
   * cancel handler consults this to POST `/v1/jobs/:id/cancel`
   * before SIGKILLing the local subprocess — without that POST,
   * a user-initiated stop would leave the cloud job running
   * until TTL (the SIGKILL bypasses the runner's `installShutdownHandlers`
   * so the runner can't issue cancel itself). Returns null when
   * the pid is unknown or the runner hasn't printed its
   * `Started job` line yet (early spawn failure, race against
   * a fast cancel, custom user bins).
   */
  getJobId(pid: number | undefined): string | null {
    if (typeof pid !== "number") return null;
    return this.entries.get(pid)?.jobId ?? null;
  }

  /**
   * Whether `dispatchRebuild` has already issued a graceful-restart
   * SIGTERM to this child as part of an HMR cycle. Consulted by
   * `/api/train`'s ReadableStream `cancel()` handler so a client-
   * driven cancel (tab close, navigation, aborted fetch) doesn't
   * pile a second SIGTERM on top of an in-progress early-stop —
   * the runner's `installShutdownHandlers` interprets a second
   * SIGTERM as the emergency `exit(143)` fast-path, which bypasses
   * the checkpoint-preserving early-stop + `cancel()` flow and
   * leaves the cloud-side run live while the local subprocess
   * dies. Defeats the main safety goal of the HMR restart logic.
   */
  isEarlyStopRequested(pid: number | undefined): boolean {
    if (typeof pid !== "number") return false;
    return this.entries.get(pid)?.earlyStopRequested ?? false;
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
  dispatchRebuild(
    nextConfigHash: string | null,
    // Defaults to `null` so tests / pre-existing callers that don't
    // pass the artefact hash get the conservative behaviour: the
    // pre-ready-spawn branch's `artefactsAgree` check is `false`,
    // so a null entry hash falls through to SIGTERM-restart. Real
    // dispatch from `/api/train`'s HMR subscriber threads
    // `event.hash` here so the backfill optimisation activates.
    nextArtifactHash: string | null = null,
  ): DispatchResult {
    const hotSwapTargets: RestartTarget[] = [];
    const restartTargets: RestartTarget[] = [];

    for (const [pid, entry] of this.entries) {
      if (entry.earlyStopRequested) continue;
      const target: RestartTarget = { pid, trainFile: entry.trainFile };
      // Pre-ready spawn: this child was registered via `/api/train`
      // *before* the HMR watcher's first successful build, so its
      // recorded `configHash` is `null`. Whether the rebuild's new
      // hash describes the same bytes the child actually loaded
      // depends on whether the on-disk artefact has changed between
      // spawn and now. Tie the decision to the artefact fingerprint:
      //
      //   - `entry.spawnArtifactHash === nextArtifactHash` → child
      //     read the same bytes the new hash describes. Safe to
      //     backfill `configHash`; future rebuilds compare against
      //     the backfilled value like any other child. This is the
      //     common case (user clicked Run before the SPA had
      //     refreshed its manifest, but the on-disk artefact is the
      //     same one the watcher just settled on).
      //
      //   - artefact fingerprints differ (or one side is null) →
      //     the bytes the child loaded don't match the new hash.
      //     SIGTERM-restart so the cloud-side `JobConfig` and the
      //     child's actual config are guaranteed to align. Without
      //     this gate, an edit landing between spawn and the first
      //     BUNDLE_END would silently teach the registry to use the
      //     post-edit hash as the child's baseline — later
      //     same-hash rebuilds would then hot-swap callbacks into
      //     a child whose cloud-side `JobConfig` was *actually*
      //     spawned against an older version, leaving the cloud
      //     run on a stale config.
      const isPreReadySpawn =
        entry.configHash === null && nextConfigHash !== null;
      if (isPreReadySpawn) {
        const artefactsAgree =
          entry.spawnArtifactHash !== null &&
          nextArtifactHash !== null &&
          entry.spawnArtifactHash === nextArtifactHash;
        if (artefactsAgree) {
          entry.configHash = nextConfigHash;
          continue;
        }
        // fall through to the mismatch / SIGTERM-restart path below
      }
      const matches =
        nextConfigHash !== null &&
        entry.configHash !== null &&
        entry.configHash === nextConfigHash;

      if (matches) {
        // On Windows, Node's `child.kill(signal)` for any unknown
        // POSIX signal (including SIGUSR2) is documented to
        // **forcefully terminate** the process — same effect as
        // SIGKILL — and `kill()` returns `true` like a successful
        // delivery. `safeKill` would then report `"ok"`, the entry
        // would land in `hotSwapTargets`, and the SPA would never
        // schedule a restart even though the child is *dead*. Skip
        // the SIGUSR2 attempt on win32 entirely and route directly
        // to the SIGTERM-restart path so the SPA learns about the
        // pending restart and re-spawns when the exit line arrives.
        // The user-visible outcome (callbacks reload after a brief
        // restart) matches the design intent on platforms where
        // the in-place hot-swap simply isn't available.
        if (process.platform !== "win32") {
          const r = safeKill(entry.child, "SIGUSR2");
          if (r === "ok") {
            hotSwapTargets.push(target);
            continue;
          }
          if (r === "gone") {
            // Child already exited; close handler will unregister.
            continue;
          }
          // Cross-platform safety net: SIGUSR2 reported `"unsupported"`
          // on a non-win32 platform (rare — `ENOSYS` from libuv signal
          // wrap on exotic builds, future Node versions removing the
          // signal, etc.). Same fallback as the win32 skip above:
          // route to SIGTERM-restart so callback edits still take
          // effect via a full restart instead of silently being
          // ignored.
        }
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
