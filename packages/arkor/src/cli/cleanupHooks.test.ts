import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCleanupHook } from "./cleanupHooks";

// Each test that emits a signal also installs new listeners on
// `process` for the lifetime of this worker. We can't `process.off`
// the listeners (they're closures inside `registerCleanupHook`) but
// we can ensure each test fires its own per-registration handler and
// process.exit is mocked so the worker survives.

let exitSpy: ReturnType<typeof vi.spyOn> | null = null;
let stdoutSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  exitSpy?.mockRestore();
  stdoutSpy?.mockRestore();
  exitSpy = null;
  stdoutSpy = null;
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

    // Cleanup body runs once even if the signal fires multiple times.
    expect(invocations).toBe(1);
    // Exit may be called multiple times (once per signal handler
    // that armed it), but the mock no-ops so the worker survives —
    // verify at least one exit fired.
    expect(codes.length).toBeGreaterThanOrEqual(1);
    expect(codes[0]).toBe(0);
  });
});
