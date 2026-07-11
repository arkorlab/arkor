import type { ChildProcess } from "node:child_process";

/**
 * Per-active-train state tracked alongside the spawned `arkor start`
 * subprocess. The Studio server records this at spawn time so HMR
 * rebuilds can decide, per child, between:
 *
 *   - **SIGUSR2** (callback hot-swap) when the new bundle's `configHash`
 *     matches the one captured at spawn time: the cloud-side run is
 *     unaffected, only in-process callbacks need to update.
 *   - **SIGTERM** (graceful early-stop + restart) when the configs
 *     diverge: the runner's internal early-stop entry point lets the
 *     next checkpoint finish, the subprocess exits, and the SPA
 *     re-spawns with the rebuilt artefact.
 */
export interface ActiveTrain {
  child: ChildProcess;
  trainFile?: string;
  /** Cloud-side config hash captured at spawn time (may be null if the
   *  manifest wasn't inspectable yet, e.g. spawn raced an in-flight
   *  build). A null entry forces SIGTERM on the next rebuild because we
   *  can't prove the configs match. */
  configHash: string | null;
  /**
   * Content hash (sha256, truncated; see `studio/hmr.ts`'s
   * `contentHashOrNull`) of the bundle this child has MOST RECENTLY
   * LOADED: the on-disk `.arkor/build/index.mjs` at spawn time,
   * then updated by `dispatchRebuild` on every successful SIGUSR2
   * hot-swap (the child re-imports the current artefact then, so
   * its loaded bundle moves with the rebuild).
   *
   * `dispatchRebuild` uses it as a content-equality gate for every
   * entry: when a rebuild's `event.contentHash` equals this value,
   * the child is provably already running that exact bundle (same
   * `JobConfig`, same callbacks), so no signal is needed and any
   * stale recorded `configHash` can be backfilled. A mismatch (or
   * null on either side) proves nothing and falls through to the
   * configHash comparison, whose conservative default is
   * SIGTERM-restart, keeping cloud-side `JobConfig` aligned with
   * what the child actually loaded.
   *
   * Content-hash (vs the timestamp `mtime+ctime+size` shape used
   * by `event.hash` for SSE dedup) avoids a false-positive
   * mismatch when a watcher rebuild produces identical bytes:
   * timestamps still bump, but content is the same and we
   * shouldn't force a spurious cancel+restart cycle. Null when
   * HMR isn't enabled or read failed.
   */
  spawnArtifactContentHash: string | null;
  /**
   * `true` once we've already SIGTERM'd this child for an HMR-driven
   * early-stop. Subsequent rebuilds (which can land before the child
   * has reached its next checkpoint) must NOT re-send SIGTERM:
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
   * `POST /v1/jobs/:id/cancel` before SIGKILLing the subprocess.
   * SIGKILL bypasses the runner's `installShutdownHandlers`, so
   * without this server-side cancel the cloud-side job would live
   * until the cloud reaper / TTL fires (continued GPU spend).
   */
  jobId: string | null;
  /**
   * Cloud-api scope (org + project slugs) captured at spawn time
   * from `.arkor/state.json`. Pinned on the registry entry so the
   * `/api/train` cancel handler can address the cloud cancel POST
   * without re-reading the filesystem at stop time. Without this
   * pin, a user who deleted or made unreadable `.arkor/state.json`
   * mid-training would have their manual stop silently skip the
   * cancel POST (state read returns null, handler bails) and
   * the cloud job would orphan. Null when `/api/train` ran without
   * state (auto-anonymous bootstrap failed, etc.); cancel POST is
   * skipped then too, but the SIGKILL still tears down the local
   * subprocess.
   */
  scope: { orgSlug: string; projectSlug: string } | null;
}

/**
 * Cloud-api endpoint + bearer token snapshotted at spawn time (same
 * capture as `/api/train`'s `spawnRpc` closure). Deliberately NOT a
 * field on `ActiveTrain` (CodeRabbit, round 84): `list()` hands out
 * entry snapshots for tests / observability, and a bearer token on
 * that shape would leak credentials into anything that ever logs or
 * serialises a snapshot. The registry keeps these in a private map
 * instead, readable only through the narrow `getRpcSnapshot(pid)`
 * cancel-context getter.
 */
export interface RpcSnapshot {
  baseUrl: string;
  token: string;
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
 *   the `kill` call: POSIX `kill(2)` raises `ESRCH` for
 *   non-existent PIDs and Node propagates it on some versions).
 * - `"unsupported"`: any *other* `kill` throw, i.e. the signal
 *   couldn't be delivered for a reason that isn't "process is gone".
 *   The motivating case is the platform not supporting this signal
 *   kind (Windows + `SIGUSR2` → `ENOSYS`; bad signal name →
 *   `EINVAL`), which `dispatchRebuild` falls back to SIGTERM-restart
 *   for. The bucket is intentionally a catch-all rather than a
 *   whitelist of error codes: rare cases like `EPERM` (lost the
 *   right to signal a re-parented child) and platform-specific
 *   surprises take the same conservative fallback (try the next
 *   signal, otherwise drop the entry), which is what callers want
 *   from "kill failed for some non-recoverable reason".
 */
type KillResult = "ok" | "gone" | "unsupported";

function safeKill(child: ChildProcess, signal: NodeJS.Signals): KillResult {
  try {
    return child.kill(signal) ? "ok" : "gone";
  } catch (err) {
    // `ESRCH` ("no such process") means the child already exited:
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

  /**
   * Spawn-time credential snapshots, keyed by pid. Kept OUT of
   * `entries` so `list()` snapshots never carry bearer tokens (see
   * the `RpcSnapshot` doc). Lifecycle mirrors `entries`: populated
   * by `register`, dropped by `unregister`.
   */
  private readonly rpcSnapshots = new Map<number, RpcSnapshot>();

  register(
    child: ChildProcess,
    init: Omit<
      ActiveTrain,
      | "child"
      | "earlyStopRequested"
      | "spawnArtifactContentHash"
      | "jobId"
      | "scope"
    > & {
      // Optional in the signature so tests / future callers that
      // don't track the on-disk artefact content hash (e.g. an
      // HMR-disabled server, a hand-rolled fake) can omit it.
      // Defaults to `null`, which forces the pre-ready-spawn
      // branch to fall through to SIGTERM-restart on the next
      // non-null rebuild (the safe choice when we genuinely
      // don't know what bytes the child loaded). Real `/api/train`
      // calls in HMR mode capture this from
      // `coordinator.getCurrentArtifactContentHash()`.
      spawnArtifactContentHash?: string | null;
      // Optional too: tests don't need scope for HMR-routing
      // assertions. Real `/api/train` calls in production pass a
      // non-null scope captured from `.arkor/state.json` so the
      // cancel POST can address the cloud job without re-reading
      // the filesystem at stop time.
      scope?: { orgSlug: string; projectSlug: string } | null;
      // Optional like `scope`: tests exercising HMR routing don't
      // need a credentials snapshot. Real `/api/train` calls pass
      // the spawn-time `spawnRpc` capture so the win32 HMR cancel
      // path can address the cloud POST with the same identity the
      // child used. Stored in the private `rpcSnapshots` map, NOT
      // on the entry, so `list()` never exposes the token.
      rpc?: RpcSnapshot | null;
    },
  ): void {
    if (typeof child.pid !== "number") return;
    const { rpc, ...entryInit } = init;
    // Mirror `entries` exactly: a re-registered pid (OS pid reuse
    // after a close whose unregister was somehow skipped) with NO
    // snapshot must not inherit the previous child's bearer token,
    // or the win32 cancel path could POST with stale credentials.
    if (rpc) this.rpcSnapshots.set(child.pid, rpc);
    else this.rpcSnapshots.delete(child.pid);
    this.entries.set(child.pid, {
      child,
      ...entryInit,
      spawnArtifactContentHash: init.spawnArtifactContentHash ?? null,
      scope: init.scope ?? null,
      earlyStopRequested: false,
      // `jobId` starts null; populated later by `recordJobId(pid,
      // id)` when the server's stdout parser sees the runner's
      // `Started job <id>` line. Tests that don't exercise the
      // cancel-POST path can leave it null.
      jobId: null,
    });
  }

  unregister(pid: number | undefined): void {
    if (typeof pid === "number") {
      this.entries.delete(pid);
      this.rpcSnapshots.delete(pid);
    }
  }

  /**
   * Narrow cancel-context getter for the spawn-time credential
   * snapshot. Only the win32 HMR-restart cancel path should consult
   * this (to address its fire-and-forget cloud cancel POST with the
   * same account / control plane the child used for createJob); the
   * token intentionally does not appear on `list()` snapshots. Null
   * when no credentials were on disk at spawn (first-run anon
   * bootstrap happens inside the child); callers fall back to a
   * cancel-time resolve then.
   */
  getRpcSnapshot(pid: number | undefined): RpcSnapshot | null {
    if (typeof pid !== "number") return null;
    return this.rpcSnapshots.get(pid) ?? null;
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
   * before SIGKILLing the local subprocess; without that POST,
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
   * Read the spawn-time cloud-api scope for a pid. Paired with
   * `getJobId` by `/api/train`'s cancel handler to build the cloud
   * cancel POST URL without re-reading `.arkor/state.json` at stop
   * time: if the file was deleted or made unreadable mid-training,
   * the read would return null and the cancel POST would silently
   * skip, orphaning the cloud run. Captured at spawn time, immutable
   * for the entry's lifetime.
   */
  getScope(
    pid: number | undefined,
  ): { orgSlug: string; projectSlug: string } | null {
    if (typeof pid !== "number") return null;
    return this.entries.get(pid)?.scope ?? null;
  }

  /**
   * Whether `dispatchRebuild` has already issued a graceful-restart
   * SIGTERM to this child as part of an HMR cycle. Consulted by
   * `/api/train`'s ReadableStream `cancel()` handler so a client-
   * driven cancel (tab close, navigation, aborted fetch) doesn't
   * pile a second SIGTERM on top of an in-progress early-stop:
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
  list(): readonly ActiveTrain[] {
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
   * decision is atomic: important because the hot-swap path can
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
    // Content hash (sha256-derived; see `studio/hmr.ts`) of the
    // freshly-built artefact, paired with `entry.spawnArtifactContentHash`
    // for the pre-ready-spawn equality gate. Defaults to `null` so
    // tests / pre-existing callers that don't pass a hash get the
    // conservative behaviour: a null entry hash falls through to
    // SIGTERM-restart. Real dispatch from `/api/train`'s HMR
    // subscriber threads `event.contentHash` here so the backfill
    // optimisation activates only when the child's loaded bytes
    // genuinely match.
    nextArtifactContentHash: string | null = null,
  ): DispatchResult {
    const hotSwapTargets: RestartTarget[] = [];
    const restartTargets: RestartTarget[] = [];

    for (const [pid, entry] of this.entries) {
      if (entry.earlyStopRequested) continue;
      const target: RestartTarget = { pid, trainFile: entry.trainFile };
      // Content-equality gate, applied to EVERY entry (not just
      // pre-ready spawns; Codex P2, round 82): when the bytes the
      // child loaded at spawn (`entry.spawnArtifactContentHash`) are
      // exactly the bytes this rebuild describes
      // (`nextArtifactContentHash`), the child is ALREADY running
      // this build: same bundle, same `JobConfig`, same callbacks.
      // No signal is needed, whatever the recorded `configHash` says.
      //
      // Two races collapse into this one rule:
      //
      //   - Pre-ready spawn: the child registered before the
      //     watcher's first successful build, so `entry.configHash`
      //     is null. Byte equality proves the new hash describes the
      //     child's actual bundle → backfill and continue.
      //
      //   - Stale spawn-time hash: a Run click landing after the
      //     watcher renamed a new artefact but before the (async)
      //     inspection updated `getCurrentConfigHash()` records the
      //     PREVIOUS build's hash while the child imports the NEW
      //     artefact. The next HMR event then looks like an
      //     old-vs-new mismatch and (before this gate) SIGTERM'd a
      //     run already spawned with the new config: pure
      //     cancel+restart churn in the save-then-immediately-run
      //     flow. Byte equality re-labels the entry with the hash
      //     that actually describes it.
      //
      // A mismatch (or a null on either side) proves nothing either
      // way, so the decision falls through to the configHash
      // comparison below, with its conservative SIGTERM-restart for
      // unprovable cases. Backfilling only when `nextConfigHash` is
      // non-null keeps a null-inspection rebuild from erasing a
      // known-good baseline.
      const artefactsAgree =
        entry.spawnArtifactContentHash !== null &&
        nextArtifactContentHash !== null &&
        entry.spawnArtifactContentHash === nextArtifactContentHash;
      if (artefactsAgree) {
        if (nextConfigHash !== null) entry.configHash = nextConfigHash;
        continue;
      }
      const matches =
        nextConfigHash !== null &&
        entry.configHash !== null &&
        entry.configHash === nextConfigHash;

      if (matches) {
        // On Windows, Node's `child.kill(signal)` for any unknown
        // POSIX signal (including SIGUSR2) is documented to
        // **forcefully terminate** the process (same effect as
        // SIGKILL), and `kill()` returns `true` like a successful
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
            // The child re-imports the CURRENT artefact on SIGUSR2,
            // so from here on "the bundle this child has loaded" is
            // this rebuild's bytes, not the spawn-time ones. Keeping
            // the entry's content hash in step is what lets the
            // content-equality gate above stay truthful: without
            // this update, a later rebuild that reverts to the
            // spawn-time bytes would byte-match the STALE spawn hash
            // and skip the SIGUSR2 the child actually needs to undo
            // the intermediate hot-swap.
            entry.spawnArtifactContentHash = nextArtifactContentHash;
            hotSwapTargets.push(target);
            continue;
          }
          if (r === "gone") {
            // Child already exited; close handler will unregister.
            continue;
          }
          // Cross-platform safety net: SIGUSR2 reported `"unsupported"`
          // on a non-win32 platform (rare: `ENOSYS` from libuv signal
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
