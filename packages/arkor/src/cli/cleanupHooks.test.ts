import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetCleanupHooksForTests,
  registerCleanupHook,
} from "./cleanupHooks";

// Each test that emits a signal also installs new listeners on
// `process` for the lifetime of this worker. Auto-detach inside the
// handlers covers the fire-then-cleanup case; `__resetCleanupHooksForTests`
// covers tests whose registration never fires (still need their
// listeners off the worker before the next test runs).

let exitSpy: ReturnType<typeof vi.spyOn> | null = null;
let stdoutSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  exitSpy?.mockRestore();
  stdoutSpy?.mockRestore();
  exitSpy = null;
  stdoutSpy = null;
  __resetCleanupHooksForTests();
});

function mockExit(): number[] {
  const codes: number[] = [];
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number) => {
      codes.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit);
  return codes;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("registerCleanupHook", () => {
  it("waits for an async sibling cleanup to settle before exitOnSignal fires", async () => {
    // Regression: previously the signal handler called
    // `process.exit(0)` immediately after kicking off cleanup, so a
    // sibling registration's async dispose (`hmr.dispose()`) got cut
    // off mid-promise. The fix coordinates via a module-level
    // in-flight set so the exit-owning hook awaits every other
    // registered cleanup before terminating.
    const order: string[] = [];
    let resolveSlowDispose!: () => void;
    const slowDispose = new Promise<void>((resolve) => {
      resolveSlowDispose = resolve;
    });

    registerCleanupHook({
      cleanup: () =>
        slowDispose.then(() => {
          order.push("async-cleanup-finished");
        }),
    });
    registerCleanupHook({
      cleanup: () => {
        order.push("sync-cleanup");
      },
      exitOnSignal: true,
    });

    const codes = mockExit();
    process.emit("SIGINT", "SIGINT");

    // Sync cleanup body has already fired; async one is still pending,
    // and exit must NOT have been called yet.
    expect(order).toEqual(["sync-cleanup"]);
    expect(codes).toEqual([]);

    // Resolve the slow dispose; one microtask later the coordinator
    // fires process.exit(0).
    resolveSlowDispose();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(order).toEqual(["sync-cleanup", "async-cleanup-finished"]);
    expect(codes).toEqual([0]);
  });

  it("auto-detaches its process listeners after firing so they don't accumulate", () => {
    // Regression: previously each `registerCleanupHook` call left
    // `process.on('exit', ...)` and per-signal listeners armed
    // forever. A long-lived Node worker that re-arms hooks (vitest
    // running many tests, or any future caller that re-registers on
    // each iteration) tripped Node's
    // `MaxListenersExceededWarning`. Fix: each handler synchronously
    // detaches its registration after invoking `run()`.
    const exitBefore = process.listeners("exit").length;
    const sigintBefore = process.listeners("SIGINT").length;
    const sigtermBefore = process.listeners("SIGTERM").length;
    const sighupBefore = process.listeners("SIGHUP").length;

    registerCleanupHook({
      cleanup: () => {},
      exitOnSignal: false,
    });

    expect(process.listeners("exit").length).toBe(exitBefore + 1);
    expect(process.listeners("SIGINT").length).toBe(sigintBefore + 1);
    expect(process.listeners("SIGTERM").length).toBe(sigtermBefore + 1);
    expect(process.listeners("SIGHUP").length).toBe(sighupBefore + 1);

    // Firing one signal must detach BOTH that registration's signal
    // listener AND its sibling exit listener — the registration is
    // done after first fire regardless of which channel triggered it.
    process.emit("SIGINT", "SIGINT");

    expect(process.listeners("exit").length).toBe(exitBefore);
    expect(process.listeners("SIGINT").length).toBe(sigintBefore);
    expect(process.listeners("SIGTERM").length).toBe(sigtermBefore);
    expect(process.listeners("SIGHUP").length).toBe(sighupBefore);
  });

  it("__resetCleanupHooksForTests detaches every still-armed registration", () => {
    // Test-only escape hatch for registrations whose handler never
    // fires inside the test (no signal emitted) — without it, those
    // listeners would persist across the vitest worker's test queue.
    const exitBefore = process.listeners("exit").length;
    registerCleanupHook({ cleanup: () => {}, exitOnSignal: false });
    registerCleanupHook({ cleanup: () => {}, exitOnSignal: true });
    expect(process.listeners("exit").length).toBe(exitBefore + 2);

    __resetCleanupHooksForTests();

    expect(process.listeners("exit").length).toBe(exitBefore);
  });

  it("is idempotent against repeated signals (done latch + bounded exit)", async () => {
    let invocations = 0;
    registerCleanupHook({
      cleanup: () => {
        invocations += 1;
      },
      exitOnSignal: true,
    });

    const codes = mockExit();
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
    await flushMicrotasks();
    await flushMicrotasks();

    // Cleanup body runs once even if the signal fires multiple times
    // (auto-detach removes the listener after first fire; the `done`
    // latch is the secondary defence in case detach is racy).
    expect(invocations).toBe(1);
    // First SIGINT fires the handler → exit(0); follow-ups hit no
    // listener after auto-detach, so codes has exactly one entry.
    expect(codes).toEqual([0]);
  });
});
