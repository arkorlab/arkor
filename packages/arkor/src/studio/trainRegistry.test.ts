import { describe, it, expect, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { TrainRegistry } from "./trainRegistry";

interface FakeChild {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(pid: number): FakeChild {
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

  it("notifyCallbackReload SIGUSR2s only matching configHashes", () => {
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

    const signalled = reg.notifyCallbackReload("match");
    expect(signalled).toEqual([
      { pid: 101, trainFile: undefined },
      { pid: 103, trainFile: undefined },
    ]);
    expect(a.kill).toHaveBeenCalledWith("SIGUSR2");
    expect(c.kill).toHaveBeenCalledWith("SIGUSR2");
    expect(b.kill).not.toHaveBeenCalled();
  });

  it("notifyCallbackReload is a no-op when nextConfigHash is null", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(201);
    reg.register(a as unknown as ChildProcess, { configHash: null });
    expect(reg.notifyCallbackReload(null)).toEqual([]);
    expect(a.kill).not.toHaveBeenCalled();
  });

  it("requestEarlyStopOnMismatch SIGTERMs only mismatched children", () => {
    const reg = new TrainRegistry();
    const same = fakeChild(301);
    const diff = fakeChild(302);
    reg.register(same as unknown as ChildProcess, { configHash: "h" });
    reg.register(diff as unknown as ChildProcess, {
      configHash: "x",
      trainFile: "/tmp/diff.ts",
    });

    const targets = reg.requestEarlyStopOnMismatch("h");
    expect(targets).toEqual([{ pid: 302, trainFile: "/tmp/diff.ts" }]);
    expect(same.kill).not.toHaveBeenCalled();
    expect(diff.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("requestEarlyStopOnMismatch SIGTERMs everything when nextConfigHash is null", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(401);
    const b = fakeChild(402);
    reg.register(a as unknown as ChildProcess, { configHash: "h" });
    reg.register(b as unknown as ChildProcess, { configHash: null });

    // null nextHash means "we couldn't inspect the new bundle" — be
    // conservative and SIGTERM every active child.
    const targets = reg.requestEarlyStopOnMismatch(null);
    expect(targets).toHaveLength(2);
    expect(a.kill).toHaveBeenCalledWith("SIGTERM");
    expect(b.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("requestEarlyStopOnMismatch SIGTERMs children whose stored hash is null", () => {
    // A spawn that raced an in-flight build can land with `configHash:
    // null`. It must not be hot-swapped — even if the new bundle's hash
    // is known, we have no proof the spawned subprocess is running the
    // same config.
    const reg = new TrainRegistry();
    const a = fakeChild(501);
    reg.register(a as unknown as ChildProcess, { configHash: null });
    const targets = reg.requestEarlyStopOnMismatch("h");
    expect(targets).toHaveLength(1);
    expect(a.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("unregister removes the child from the policy decisions", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(601);
    reg.register(a as unknown as ChildProcess, { configHash: "h" });
    reg.unregister(601);
    expect(reg.size).toBe(0);
    expect(reg.notifyCallbackReload("h")).toEqual([]);
  });

  it("survives kill() throwing (child exited mid-iteration)", () => {
    const reg = new TrainRegistry();
    const a = fakeChild(701);
    a.kill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    reg.register(a as unknown as ChildProcess, { configHash: "h" });
    // Both code paths should swallow the throw and continue with their
    // bookkeeping so a single dead child can't break HMR for siblings.
    expect(() => reg.notifyCallbackReload("h")).not.toThrow();
    expect(() => reg.requestEarlyStopOnMismatch("x")).not.toThrow();
  });
});
