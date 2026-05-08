import { describe, it, expect, vi } from "vitest";
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
    // null nextHash means "we couldn't inspect the new bundle" — be
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

  it("dispatchRebuild backfills the hash and skips dispatch when the spawn-time hash was null", () => {
    // Regression: previously a child registered with `configHash:
    // null` (spawn happened *before* the HMR watcher emitted its
    // first successful build, so `getCurrentConfigHash()` returned
    // null) was treated as a hash mismatch on the next event with
    // a real hash and SIGTERM-restarted. Since the dispatch now
    // fires on `ready` events too, that turned every "click Run
    // before the watcher's first BUNDLE_END" into a spurious
    // cancel+restart cycle (extra GPU spend / job churn) triggered
    // purely by startup timing rather than any actual code change.
    // The fix backfills the entry's hash with the first known value
    // and skips signal dispatch — the child either already loaded
    // the right bundle or surfaces its own load error; future
    // rebuilds compare against the backfilled hash like any other.
    const reg = new TrainRegistry();
    const c = fakeChild(401);
    reg.register(c as unknown as ChildProcess, {
      configHash: null,
      trainFile: "/tmp/preready.ts",
    });
    const result = reg.dispatchRebuild("first-real-hash");
    // Neither bucket — no signal sent, nothing for the SPA to react to.
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
    expect(c.kill).not.toHaveBeenCalled();
    // A subsequent dispatch with the SAME hash must take the hot-
    // swap path (proves the backfill landed; without it this would
    // STILL be null vs "first-real-hash" → SIGTERM).
    const second = reg.dispatchRebuild("first-real-hash");
    expect(second.hotSwapTargets).toEqual([
      { pid: 401, trainFile: "/tmp/preready.ts" },
    ]);
    expect(second.restartTargets).toEqual([]);
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
    // And a different hash on a later rebuild now correctly routes
    // to SIGTERM-restart (backfilled hash is real).
    c.kill.mockClear();
    const third = reg.dispatchRebuild("second-hash");
    expect(third.restartTargets).toEqual([
      { pid: 401, trainFile: "/tmp/preready.ts" },
    ]);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
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
    // target — the SPA would then wait forever for the (already-
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
    // POSIX `kill(2)` raises `ESRCH` for an already-exited child —
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
    const result = reg.dispatchRebuild("match");
    // No hot-swap (SIGUSR2 failed), no restart (correctly classified
    // as gone, NOT routed into the SIGTERM fallback path).
    expect(result.hotSwapTargets).toEqual([]);
    expect(result.restartTargets).toEqual([]);
    // Single SIGUSR2 attempt — no SIGTERM fallback was issued.
    expect(goneOnSigusr2.kill).toHaveBeenCalledTimes(1);
    expect(goneOnSigusr2.kill).toHaveBeenCalledWith("SIGUSR2");
  });

  it("dispatchRebuild omits dead-on-kill children when kill returns false (no throw)", () => {
    // Regression: `ChildProcess.kill()` returns `false` (without
    // throwing) when the target process is already gone. The previous
    // implementation treated any non-throw as success and reported the
    // child as a restart target — the SPA would then wait forever for
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
    // We still attempted the kill — only the bookkeeping is skipped.
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

  it("dispatchRebuild degrades to SIGTERM-restart when SIGUSR2 is unsupported (Windows)", () => {
    // Regression: Node's win32 build doesn't deliver SIGUSR2 (it
    // throws "ENOSYS" inside `child.kill('SIGUSR2')`). The previous
    // implementation silently swallowed that throw, so on Windows a
    // hash-match rebuild produced neither hot-swap nor restart and
    // callback edits never landed. Now we degrade to a SIGTERM-driven
    // restart so the new code does take effect — at the cost of a
    // brief gap rather than an in-place swap.
    const reg = new TrainRegistry();
    const a = fakeChild(901);
    a.kill.mockImplementation((sig?: string) => {
      if (sig === "SIGUSR2") {
        const err = new Error(
          "kill ENOSYS",
        ) as Error & { code?: string };
        err.code = "ENOSYS";
        throw err;
      }
      return true; // SIGTERM works
    });
    reg.register(a as unknown as ChildProcess, {
      configHash: "match",
      trainFile: "/tmp/win.ts",
    });
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
});
