import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { TrainRegistry } from "./trainRegistry";

interface FakeChild {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(pid: number): FakeChild {
  // Default: `kill(sig)` returns `true`, mirroring Node's contract for
  // a successful signal delivery to a still-running process.
  return { pid, kill: vi.fn(() => true) };
}

describe("TrainRegistry", () => {
  // Pin `process.platform` to "linux" for every test in this file so the
  // POSIX/SIGUSR2 dispatch path is exercised regardless of the host CI
  // runner. `dispatchRebuild` gates the SIGUSR2 hot-swap attempt on
  // `process.platform !== "win32"` (Codex P1 fix: win32 maps unknown
  // signals to SIGKILL-equivalent and would silently misreport hot-swap
  // success), so on the Windows CI matrix the SIGUSR2 path would never
  // fire and tests asserting on it would all fail. The single
  // win32-specific test below (`dispatchRebuild on win32 routes hash-
  // matches directly to SIGTERM-restart`) overrides this pin inside its
  // own try/finally to exercise the win32 branch.
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
  });
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("ignores children without a pid (already-exited spawns)", () => {
    const reg = new TrainRegistry();
    reg.register({ pid: undefined } as unknown as ChildProcess, {
      configHash: "h1",
    });
    expect(reg.size).toBe(0);
  });

  it("dispatchRebuild SIGUSR2s only matching configHashes", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(101);
    const b = fakeChild(102);
    const c = fakeChild(103);
    reg.register(a as unknown as ChildProcess, { configHash: "match" });
    reg.register(b as unknown as ChildProcess, {
      configHash: "different",
      trainFile: "/tmp/b.ts",
    });
    reg.register(c as unknown as ChildProcess, { configHash: "match" });
    // Arm the SIGUSR2 readiness handshake: hot-swap requires the
    // runner's job marker to have been recorded (see dispatchRebuild).
    reg.recordJobId(101, "j-a");
    reg.recordJobId(102, "j-b");
    reg.recordJobId(103, "j-c");

    const result = reg.dispatchRebuild("match");
    expect(result.hotSwapTargets).toEqual([
      { pid: 101, trainFile: undefined },
      { pid: 103, trainFile: undefined },
    ]);
    expect(result.restartTargets).toEqual([
      { pid: 102, trainFile: "/tmp/b.ts" },
    ]);
    expect(a.kill).toHaveBeenCalledWith("SIGUSR2");
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
    expect(b.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispatchRebuild SIGTERMs everything when nextConfigHash is null", () => {
    // null nextHash means "we couldn't inspect the new bundle": be
    // conservative and SIGTERM every active child since we can't
    // prove their configs are unaffected.
    const reg = new TrainRegistry();
    const a = fakeChild(201);
    const b = fakeChild(202);
    reg.register(a as unknown as ChildProcess, { configHash: "h" });
    reg.register(b as unknown as ChildProcess, { configHash: null });

    const result = reg.dispatchRebuild(null);
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toHaveLength(2);
    expect(a.kill).toHaveBeenCalledWith("SIGTERM");
    expect(b.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispatchRebuild backfills the hash and skips dispatch when the spawn-time artefact matches the new build", () => {
    // Pre-ready spawn (configHash: null) is the "user clicked Run
    // before the watcher's first BUNDLE_END" case. Whether it's
    // safe to backfill the new hash as the child's baseline depends
    // on whether the on-disk artefact has changed between spawn
    // and now: if `spawnArtifactContentHash === nextArtifactContentHash`, the
    // child read exactly the bytes the new hash describes →
    // backfill + skip dispatch (no spurious cancel+restart cycle).
    // Otherwise (see the next test) SIGTERM-restart so cloud
    // and child stay aligned.
    const reg = new TrainRegistry();
    const c = fakeChild(401);
    reg.register(c as unknown as ChildProcess, {
      configHash: null,
      trainFile: "/tmp/preready.ts",
      spawnArtifactContentHash: "art-v1",
    });
    reg.recordJobId(401, "j-401");
    const result = reg.dispatchRebuild("first-real-hash", "art-v1");
    // Neither bucket: no signal sent, nothing for the SPA to react to.
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
    expect(c.kill).not.toHaveBeenCalled();
    // A subsequent dispatch with the SAME config hash must take the
    // hot-swap path (proves the backfill landed; without it this
    // would STILL be null vs "first-real-hash" → SIGTERM).
    const second = reg.dispatchRebuild("first-real-hash", "art-v2");
    expect(second.hotSwapTargets).toEqual([
      { pid: 401, trainFile: "/tmp/preready.ts" },
    ]);
    expect(second.restartTargets).toEqual([]);
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
    // And a different config hash on a later rebuild now correctly
    // routes to SIGTERM-restart (backfilled hash is real).
    c.kill.mockClear();
    const third = reg.dispatchRebuild("second-hash", "art-v3");
    expect(third.restartTargets).toEqual([
      { pid: 401, trainFile: "/tmp/preready.ts" },
    ]);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispatchRebuild skips signalling when the child already loaded this exact bundle, even with a stale non-null configHash", () => {
    // Codex P2 (round 82): a Run click landing after the watcher
    // renamed a new artefact but BEFORE the async inspection updated
    // `getCurrentConfigHash()` records the previous build's hash
    // while the child imports the new bundle. The next HMR event
    // then looks like an old-vs-new config mismatch and (before the
    // generalized content gate) SIGTERM'd a run that was already
    // spawned with the new config: pure cancel+restart churn in the
    // save-then-immediately-run flow. Byte equality proves the child
    // runs exactly this build, so no signal fires and the stale
    // hash is re-labelled.
    const reg = new TrainRegistry();
    const c = fakeChild(451);
    reg.register(c as unknown as ChildProcess, {
      configHash: "stale-previous-hash",
      trainFile: "/tmp/stale.ts",
      spawnArtifactContentHash: "art-new",
    });
    reg.recordJobId(451, "j-451");
    const result = reg.dispatchRebuild("new-hash", "art-new");
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
    expect(c.kill).not.toHaveBeenCalled();
    // The backfill re-labelled the entry: a later same-config rebuild
    // with different bytes hot-swaps instead of restarting.
    const second = reg.dispatchRebuild("new-hash", "art-v2");
    expect(second.hotSwapTargets).toEqual([
      { pid: 451, trainFile: "/tmp/stale.ts" },
    ]);
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
  });

  it("dispatchRebuild tracks the loaded bundle across hot-swaps so a revert-to-spawn-bytes rebuild still SIGUSR2s", () => {
    // Regression guard for the content-equality gate: a successful
    // SIGUSR2 makes the child re-import the CURRENT artefact, so the
    // entry's "loaded bundle" hash must move with it. If it stayed
    // pinned to the spawn-time value, this sequence would break:
    // spawn on bytes A → hot-swap to bytes B (same config, new
    // callbacks) → user reverts the edit → rebuild emits bytes A
    // again. The revert build byte-matches the STALE spawn hash, the
    // gate would skip dispatch, and the child would keep B's
    // callbacks while the artefact on disk says A: a silent stale
    // hot-swap.
    const reg = new TrainRegistry();
    const c = fakeChild(461);
    reg.register(c as unknown as ChildProcess, {
      configHash: "same-config",
      spawnArtifactContentHash: "art-A",
    });
    reg.recordJobId(461, "j-461");
    // Callback-only edit: same config, new bytes → hot-swap.
    const first = reg.dispatchRebuild("same-config", "art-B");
    expect(first.hotSwapTargets).toHaveLength(1);
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
    c.kill.mockClear();
    // Revert: bytes are A again. The child currently holds B's
    // callbacks, so this MUST hot-swap again, not skip.
    const second = reg.dispatchRebuild("same-config", "art-A");
    expect(second.hotSwapTargets).toHaveLength(1);
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
  });

  it("dispatchRebuild SIGTERM-restarts a pre-ready spawn when the artefact has changed since spawn", () => {
    // Codex P2 regression: an edit landing between spawn and the
    // watcher's first BUNDLE_END means the bytes the child loaded
    // differ from what the new `configHash` describes. Backfilling
    // unconditionally would silently teach the registry to use the
    // post-edit hash as the child's baseline; later same-hash
    // rebuilds would then hot-swap callbacks into a child whose
    // cloud-side `JobConfig` was actually spawned against an older
    // version, leaving the cloud run on a stale config. The artefact
    // fingerprint mismatch (`art-stale` vs `art-fresh`) is the
    // signal that the child loaded older bytes; SIGTERM-restart
    // forces a clean re-spawn against the freshly-built artefact.
    const reg = new TrainRegistry();
    const c = fakeChild(411);
    reg.register(c as unknown as ChildProcess, {
      configHash: null,
      trainFile: "/tmp/preready-stale.ts",
      spawnArtifactContentHash: "art-stale",
    });
    const result = reg.dispatchRebuild("real-hash", "art-fresh");
    // SIGTERM-restart: the child's bytes are stale relative to the
    // new build. Hot-swap would be unsafe (config drift); skip
    // would leave the child running with no future correction
    // path (the registry would treat "real-hash" as the baseline
    // even though the child never loaded that build).
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([
      { pid: 411, trainFile: "/tmp/preready-stale.ts" },
    ]);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispatchRebuild SIGTERM-restarts a pre-ready spawn when no artefact existed at spawn time", () => {
    // Companion to the "artefact has changed" test: a fresh project
    // never built before spawn means `coordinator.getCurrentArtifactContentHash()`
    // returned `null` (no on-disk artefact to read bytes from), so
    // `spawnArtifactContentHash` was registered as `null`. The pre-
    // ready-spawn backfill gate compares `entry.spawnArtifactContentHash`
    // against the rebuild's `nextArtifactContentHash`, and a null on
    // either side falls through to SIGTERM-restart since we can't
    // prove the child's loaded bytes match the new hash. Conservative
    // restart so the SPA re-spawns once the new bundle is on disk.
    const reg = new TrainRegistry();
    const c = fakeChild(421);
    reg.register(c as unknown as ChildProcess, {
      configHash: null,
      trainFile: "/tmp/preready-fresh.ts",
      spawnArtifactContentHash: null, // no artefact when /api/train fired
    });
    const result = reg.dispatchRebuild("first-real-hash", "art-fresh");
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([
      { pid: 421, trainFile: "/tmp/preready-fresh.ts" },
    ]);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("routes a hash-match to SIGTERM-restart while the runner's job marker hasn't been recorded (SIGUSR2 readiness gate)", () => {
    // cubic P1 (round 86): SIGUSR2's default disposition TERMINATES a
    // process with no handler, and the runner only arms its handler
    // during startup. A callback-only rebuild landing in the
    // spawn-to-armed window would kill the child while dispatch
    // reported hotSwapTargets success. The recorded `Started job`
    // marker doubles as the readiness handshake (it prints strictly
    // after the handler is armed), so a markerless entry must route
    // to SIGTERM-restart even on a perfect hash match, and the
    // forcedKill flag mirrors the platform.
    const reg = new TrainRegistry();
    const c = fakeChild(471);
    reg.register(c as unknown as ChildProcess, {
      configHash: "match",
      trainFile: "/tmp/unready.ts",
      spawnArtifactContentHash: "art-old",
    });
    const result = reg.dispatchRebuild("match", "art-new");
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([
      { pid: 471, trainFile: "/tmp/unready.ts" },
    ]);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    expect(c.kill).not.toHaveBeenCalledWith("SIGUSR2");
    // Once the marker lands, the same match hot-swaps. (Re-register:
    // the first dispatch latched earlyStopRequested.)
    reg.unregister(471);
    const d = fakeChild(472);
    reg.register(d as unknown as ChildProcess, { configHash: "match" });
    reg.recordJobId(472, "j-472");
    const second = reg.dispatchRebuild("match", "art-newer");
    expect(second.hotSwapTargets).toEqual([{ pid: 472, trainFile: undefined }]);
    expect(d.kill).toHaveBeenCalledWith("SIGUSR2");
  });

  it("dispatchRebuild does not re-signal a child it already SIGTERMed (earlyStopRequested latch)", () => {
    // The latch is internal now (the public getter was removed once
    // the manual-Stop path stopped consulting it); its contract is
    // observable through dispatch: a second rebuild must not pile a
    // second SIGTERM on a child whose graceful early-stop is already
    // in flight (the runner treats signal #2 as the exit(143)
    // emergency path, which would defeat the checkpoint wait).
    const reg = new TrainRegistry();
    const a = fakeChild(901);
    reg.register(a as unknown as ChildProcess, { configHash: "h-old" });
    reg.dispatchRebuild("h-new");
    expect(a.kill).toHaveBeenCalledTimes(1);
    const second = reg.dispatchRebuild("h-newer");
    expect(a.kill).toHaveBeenCalledTimes(1);
    expect(second.restartTargets).toEqual([]);
    // Unregister clears the latch with the entry.
    reg.unregister(901);
    reg.register(a as unknown as ChildProcess, { configHash: "h-old" });
    reg.dispatchRebuild("h-new2");
    expect(a.kill).toHaveBeenCalledTimes(2);
  });

  it("unregister removes the child from the policy decisions", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(401);
    reg.register(a as unknown as ChildProcess, { configHash: "h" });
    reg.unregister(401);
    expect(reg.size).toBe(0);
    const result = reg.dispatchRebuild("h");
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
  });

  it("survives kill() throwing (child exited mid-iteration)", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(501);
    a.kill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    reg.register(a as unknown as ChildProcess, { configHash: "h" });
    // Both the hot-swap branch (matching hash) and the restart branch
    // (mismatched hash) must swallow the throw and continue with their
    // bookkeeping so a single dead child can't break HMR for siblings.
    expect(() => reg.dispatchRebuild("h")).not.toThrow();
    expect(() => reg.dispatchRebuild("x")).not.toThrow();
  });

  it("dispatchRebuild omits dead-on-kill children from the restart targets", () => {
    // Regression: previously the implementation always pushed onto
    // `targets` even when `kill()` threw, so a child that had already
    // exited would still be reported back to the SPA as a restart
    // target: the SPA would then wait forever for the (already-
    // delivered) `exit=...` line and never re-spawn.
    const reg = new TrainRegistry();
    const dead = fakeChild(601);
    dead.kill.mockImplementation(() => {
      const err = new Error("kill ESRCH") as Error & { code?: string };
      err.code = "ESRCH";
      throw err;
    });
    reg.register(dead as unknown as ChildProcess, {
      configHash: "stale",
      trainFile: "/tmp/d.ts",
    });
    const result = reg.dispatchRebuild("fresh");
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
  });

  it("dispatchRebuild classifies ESRCH on the hash-match branch as 'gone' (no SIGTERM fallback)", () => {
    // Regression: `safeKill` previously treated any thrown error as
    // `"unsupported"`, which on the hash-match branch triggers a
    // SIGTERM fallback (intended for Windows + SIGUSR2 unsupported).
    // POSIX `kill(2)` raises `ESRCH` for an already-exited child:
    // classifying that as "unsupported" caused a needless SIGTERM
    // attempt against a dead PID. Now ESRCH routes through the
    // "gone" branch (no fallback, no restart-target push) so the
    // child is dropped silently for the close handler to reap.
    const reg = new TrainRegistry();
    const goneOnSigusr2 = fakeChild(801);
    goneOnSigusr2.kill.mockImplementation(() => {
      const err = new Error("kill ESRCH") as Error & { code?: string };
      err.code = "ESRCH";
      throw err;
    });
    reg.register(goneOnSigusr2 as unknown as ChildProcess, {
      configHash: "match",
      trainFile: "/tmp/g.ts",
    });
    reg.recordJobId(801, "j-801");
    const result = reg.dispatchRebuild("match");
    // No hot-swap (SIGUSR2 failed), no restart (correctly classified
    // as gone, NOT routed into the SIGTERM fallback path).
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
    // Single SIGUSR2 attempt: no SIGTERM fallback was issued.
    expect(goneOnSigusr2.kill).toHaveBeenCalledTimes(1);
    expect(goneOnSigusr2.kill).toHaveBeenCalledWith("SIGUSR2");
  });

  it("dispatchRebuild omits dead-on-kill children when kill returns false (no throw)", () => {
    // Regression: `ChildProcess.kill()` returns `false` (without
    // throwing) when the target process is already gone. The previous
    // implementation treated any non-throw as success and reported the
    // child as a restart target; the SPA would then wait forever for
    // an exit line that already arrived.
    const reg = new TrainRegistry();
    const gone = fakeChild(701);
    gone.kill.mockReturnValue(false);
    reg.register(gone as unknown as ChildProcess, {
      configHash: "stale",
      trainFile: "/tmp/g.ts",
    });
    const result = reg.dispatchRebuild("fresh");
    expect(result.restartTargets).toEqual([]);
    // We still attempted the kill; only the bookkeeping is skipped.
    expect(gone.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("dispatchRebuild sends SIGTERM at most once per child across rebuilds", () => {
    // Regression: under rapid edits the dev loop can fire multiple
    // rebuilds before the child reaches its next checkpoint. The
    // runner's shutdown handler treats a *second* SIGTERM as the
    // emergency `exit(143)` fast-path, which would defeat the whole
    // point of preserving the in-flight checkpoint. The registry now
    // tracks per-child early-stop state and skips children it has
    // already signalled.
    const reg = new TrainRegistry();
    const a = fakeChild(801);
    reg.register(a as unknown as ChildProcess, {
      configHash: "h1",
      trainFile: "/tmp/a.ts",
    });

    const first = reg.dispatchRebuild("h2");
    expect(first.restartTargets).toEqual([
      { pid: 801, trainFile: "/tmp/a.ts" },
    ]);
    expect(a.kill).toHaveBeenCalledTimes(1);

    // Second mismatching rebuild before the child has exited: must NOT
    // re-send SIGTERM and must NOT re-list the child as a restart
    // target (the SPA already has a pending re-spawn for it).
    const second = reg.dispatchRebuild("h3");
    expect(second.restartTargets).toEqual([]);
    expect(a.kill).toHaveBeenCalledTimes(1);

    // After the child exits and is unregistered, a fresh spawn in its
    // place starts from a clean slate.
    reg.unregister(801);
    const respawn = fakeChild(802);
    reg.register(respawn as unknown as ChildProcess, {
      configHash: "h3",
      trainFile: "/tmp/a.ts",
    });
    const third = reg.dispatchRebuild("h4");
    expect(third.restartTargets).toEqual([
      { pid: 802, trainFile: "/tmp/a.ts" },
    ]);
    expect(respawn.kill).toHaveBeenCalledTimes(1);
  });

  it("dispatchRebuild on win32 routes hash-matches directly to SIGTERM-restart (skips SIGUSR2 attempt)", () => {
    // Regression: Node's `child.kill("SIGUSR2")` on Windows is
    // documented to **forcefully terminate** the process (treats
    // any unknown POSIX signal as SIGKILL-equivalent) and STILL
    // returns `true` like a successful delivery. `safeKill` would
    // then report `"ok"` → entry lands in `hotSwapTargets` → SPA
    // shows "hot-swap" and skips restart, but the child is already
    // dead. The Codex P1 fix gates the SIGUSR2 attempt behind
    // `process.platform !== "win32"` so win32 routes straight to
    // SIGTERM-restart, surfacing a real restart target the SPA can
    // act on.
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      const reg = new TrainRegistry();
      const a = fakeChild(951);
      a.kill.mockReturnValue(true); // win32 reports success even for SIGUSR2
      reg.register(a as unknown as ChildProcess, {
        configHash: "match",
        trainFile: "/tmp/win.ts",
      });
      const result = reg.dispatchRebuild("match");
      // Restart bucket only: hot-swap is unsafe on win32 even
      // when kill() reported "ok".
      expect(result.hotSwapTargets).toEqual([]);
      // `forcedKill: true` rides along on win32 so the SPA's
      // nonzero-exit suppression lets this restart through (the
      // abrupt kill can't produce the clean exit=0 the gate wants).
      expect(result.restartTargets).toEqual([
        { pid: 951, trainFile: "/tmp/win.ts", forcedKill: true },
      ]);
      // SIGUSR2 was NEVER attempted: the platform gate skipped it
      // entirely and went straight to the SIGTERM fallback path.
      // (Without the gate, SIGUSR2 would have fired first and been
      // misclassified as a successful hot-swap.)
      expect(a.kill).toHaveBeenCalledTimes(1);
      expect(a.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("dispatchRebuild degrades to SIGTERM-restart when SIGUSR2 throws `unsupported` on a non-win32 platform", () => {
    // Cross-platform safety net for the SIGUSR2 hot-swap path. On the
    // standard win32 build the previous test ("dispatchRebuild on
    // win32 routes hash-matches directly to SIGTERM-restart") already
    // covers the *up-front* `process.platform === "win32"` skip;
    // dispatch never even *attempts* SIGUSR2 there. This case covers
    // the OTHER way SIGUSR2 can come back unusable: an exotic non-
    // win32 Node build (libuv signal-wrap raising `ENOSYS`, future
    // Node version removing the signal, lost-rights `EPERM` on a
    // re-parented child) where `safeKill` returns `"unsupported"`.
    // Because the `beforeEach` in this suite pins `process.platform`
    // to `"linux"`, the up-front skip is bypassed and we exercise
    // the SIGUSR2-throws fallback inside `safeKill`. Without the
    // fallback the child would land in NEITHER bucket and callback
    // edits would silently disappear; with the fallback we route to
    // SIGTERM-restart so the new code at least takes effect via a
    // brief gap instead of an in-place swap.
    const reg = new TrainRegistry();
    const a = fakeChild(901);
    a.kill.mockImplementation((sig?: string) => {
      if (sig === "SIGUSR2") {
        const err = new Error("kill ENOSYS") as Error & { code?: string };
        err.code = "ENOSYS";
        throw err;
      }
      return true; // SIGTERM works
    });
    reg.register(a as unknown as ChildProcess, {
      configHash: "match",
      trainFile: "/tmp/win.ts",
    });
    reg.recordJobId(901, "j-901");
    const result = reg.dispatchRebuild("match");
    // Must not appear in hot-swap (signal failed) but must appear in
    // restart (fallback succeeded) so the SPA re-spawns once the
    // exit message arrives.
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([
      { pid: 901, trainFile: "/tmp/win.ts" },
    ]);
    // Both signals were attempted in order: SIGUSR2 → fallback SIGTERM.
    expect(a.kill).toHaveBeenNthCalledWith(1, "SIGUSR2");
    expect(a.kill).toHaveBeenNthCalledWith(2, "SIGTERM");
  });

  it("rpc snapshots mirror the entry lifecycle and never leak across pid reuse", () => {
    // The spawn-time credential snapshot lives in a private map (so
    // `list()` never exposes bearer tokens); this pins its lifecycle:
    //   - register with `rpc` → readable via the narrow getter;
    //   - re-register the SAME pid without `rpc` (OS pid reuse after
    //     a close whose unregister was skipped) → the previous
    //     child's token must NOT be inherited;
    //   - unregister → snapshot dropped.
    const reg = new TrainRegistry();
    const a = fakeChild(951);
    reg.register(a as unknown as ChildProcess, {
      configHash: "h",
      rpc: { baseUrl: "http://spawn-time", token: "tok-1" },
    });
    expect(reg.getRpcSnapshot(951)).toEqual({
      baseUrl: "http://spawn-time",
      token: "tok-1",
    });
    // `list()` snapshots carry no token-bearing field.
    for (const entry of reg.list()) {
      expect(Object.values(entry)).not.toContainEqual(
        expect.objectContaining({ token: expect.anything() }),
      );
    }

    const reused = fakeChild(951);
    reg.register(reused as unknown as ChildProcess, { configHash: "h2" });
    expect(reg.getRpcSnapshot(951)).toBeNull();

    reg.register(reused as unknown as ChildProcess, {
      configHash: "h3",
      rpc: { baseUrl: "http://spawn-time", token: "tok-2" },
    });
    reg.unregister(951);
    expect(reg.getRpcSnapshot(951)).toBeNull();
    expect(reg.getRpcSnapshot(undefined)).toBeNull();
  });
});
