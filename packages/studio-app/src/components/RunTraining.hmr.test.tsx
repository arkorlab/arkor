// @vitest-environment jsdom
//
// HMR restart state-machine suite for <RunTraining /> (CodeRabbit,
// PR #101 round 81). The sibling `RunTraining.test.tsx` exercises the
// component through the real `lib/api` module with a mocked `fetch`;
// that's the right shape for manifest/log-pane behaviour but can't
// drive the HMR paths deterministically (EventSource isn't available
// under jsdom, and stream lifetimes need per-test control). This file
// module-mocks `../lib/api` instead, so each test can:
//
//   - push synthetic `/api/dev/events` frames at exact points in a
//     run's lifecycle (fake EventSource),
//   - hold a `streamTraining` call open and settle it with a chosen
//     exit code whenever the scenario calls for it,
//   - resolve `fetchManifest` out of order to exercise the seq fence.
//
// Together these pin the risky arbitration logic: pre-spawn event
// buffering, per-pid restart scoping, Stop-beats-restart, the
// late-SSE grace window, and nonzero-exit restart suppression.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { DevEvent, ManifestResult } from "../lib/api";

vi.mock("../lib/api", () => ({
  fetchManifest: vi.fn(),
  isHmrEnabled: vi.fn(() => true),
  openDevEvents: vi.fn(),
  streamTraining: vi.fn(),
}));

import {
  fetchManifest,
  isHmrEnabled,
  openDevEvents,
  streamTraining,
} from "../lib/api";

import { RunTraining } from "./RunTraining";

/**
 * Minimal EventSource stand-in. The component registers the same
 * handler for "ready" / "rebuild" / "error"; `emit` invokes it with a
 * real jsdom MessageEvent so the `raw instanceof MessageEvent` narrow
 * inside the component passes.
 */
function fakeEventSource() {
  const handlers = new Map<string, (e: Event) => void>();
  const es = {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      handlers.set(type, fn);
    },
    close: vi.fn(),
  };
  return {
    es: es as unknown as EventSource,
    emit(type: DevEvent["type"], payload: DevEvent) {
      const fn = handlers.get(type);
      if (!fn) throw new Error(`no handler registered for ${type}`);
      act(() => {
        fn(new MessageEvent(type, { data: JSON.stringify(payload) }));
      });
    },
  };
}

/**
 * Per-call handle over a mocked `streamTraining` invocation. Tests
 * decide when the spawned pid becomes known (`spawn`) and when (and
 * with what exit code) the stream settles (`finish`). Mirrors the
 * real contract: the promise resolves with the exit code parsed off
 * the train stream's trailing `exit=` marker, `null` when no numeric
 * marker was seen (aborted stream, signal-killed child, truncated
 * body), and rejects on the `error=` spawn-failure marker (`fail`).
 */
interface StreamHandle {
  file: string | undefined;
  signal: AbortSignal | undefined;
  spawn: (pid: number | null) => void;
  finish: (exitCode: number | null) => Promise<void>;
  /**
   * Settle the stream with a rejection, the way the real
   * `streamTraining` now rejects on the server's `error=` marker
   * (spawn failure) or a non-2xx `/api/train` response.
   */
  fail: (message: string) => Promise<void>;
}

function installStreamMock(): StreamHandle[] {
  const handles: StreamHandle[] = [];
  vi.mocked(streamTraining).mockImplementation(
    (_onChunk, file, signal, onSpawn) =>
      new Promise<number | null>((resolve, reject) => {
        const handle: StreamHandle = {
          file,
          signal,
          spawn: (pid) => {
            act(() => onSpawn?.(pid));
          },
          finish: async (exitCode) => {
            await act(async () => {
              resolve(exitCode);
              // Let run()'s continuation (post-await cleanup + the
              // queueMicrotask restart hop) drain before returning.
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          },
          fail: async (message) => {
            await act(async () => {
              reject(new Error(message));
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
          },
        };
        // The component aborts the previous stream when a new run
        // starts and on unmount; settle with `null` (no marker) the
        // way the real implementation's cancelled reader does, so
        // held-open streams can't leak across tests.
        signal?.addEventListener("abort", () => resolve(null));
        handles.push(handle);
      }),
  );
  return handles;
}

const GOOD_MANIFEST: ManifestResult = {
  trainer: { name: "demo" },
  configHash: "h1",
};

let sse: ReturnType<typeof fakeEventSource>;
let streams: StreamHandle[];

beforeEach(() => {
  vi.mocked(fetchManifest).mockResolvedValue(GOOD_MANIFEST);
  vi.mocked(isHmrEnabled).mockReturnValue(true);
  sse = fakeEventSource();
  vi.mocked(openDevEvents).mockReturnValue(sse.es);
  streams = installStreamMock();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Render, wait for the manifest to enable Run, click it, surface pid. */
async function startRun(pid = 111): Promise<StreamHandle> {
  const user = userEvent.setup();
  render(<RunTraining />);
  const runBtn = await screen.findByRole("button", {
    name: /run training: demo/i,
  });
  await user.click(runBtn);
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  const handle = streams[0];
  handle.spawn(pid);
  return handle;
}

function restartEvent(pid: number): DevEvent {
  return {
    type: "rebuild",
    outFile: "/tmp/x.mjs",
    hash: "h",
    configHash: "h2",
    trainerName: "demo",
    restart: true,
    restartTargets: [{ pid }],
  };
}

function hotSwapEvent(pid: number): DevEvent {
  return {
    type: "rebuild",
    outFile: "/tmp/x.mjs",
    hash: "h",
    configHash: "h1",
    trainerName: "demo",
    hotSwap: true,
    hotSwapTargets: [{ pid }],
  };
}

describe("<RunTraining /> HMR restart state machine", () => {
  it("auto-restarts after a restart-targeted rebuild lands and the stream exits cleanly (fast path)", async () => {
    const first = await startRun(111);

    sse.emit("rebuild", restartEvent(111));
    // The latch trips immediately: the UI shows the early-stop label
    // while the child runs to its next checkpoint.
    expect(
      await screen.findByText(/stopping at next checkpoint/i),
    ).toBeInTheDocument();

    await first.finish(0);
    // run()'s finally sees the latch and re-spawns with the same file.
    await waitFor(() => expect(streamTraining).toHaveBeenCalledTimes(2));
    expect(streams[1].file).toBe(first.file);
  });

  it("ignores restart events that target another tab's pid", async () => {
    const first = await startRun(111);

    sse.emit("rebuild", restartEvent(999));
    // Foreign pid: no early-stopping label, no latch.
    expect(
      screen.queryByText(/stopping at next checkpoint/i),
    ).not.toBeInTheDocument();

    await first.finish(0);
    // Grace window (250 ms) gives a late same-pid event a chance to
    // land; none arrives, so no restart fires.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(streamTraining).toHaveBeenCalledTimes(1);
  });

  it("flashes the hot-swapped status without scheduling a restart", async () => {
    const first = await startRun(111);

    sse.emit("rebuild", hotSwapEvent(111));
    expect(
      await screen.findByText(/callbacks hot-swapped/i),
    ).toBeInTheDocument();

    await first.finish(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(streamTraining).toHaveBeenCalledTimes(1);
  });

  it("buffers a restart event that arrives before the pid is known and drains it in onSpawn", async () => {
    const user = userEvent.setup();
    render(<RunTraining />);
    const runBtn = await screen.findByRole("button", {
      name: /run training: demo/i,
    });
    await user.click(runBtn);
    await waitFor(() => expect(streams.length).toBe(1));
    const first = streams[0];

    // Restart event lands in the pre-spawn window: runningRef is true
    // but onSpawn hasn't delivered the pid yet. The per-pid filter
    // can't match, so the event must be buffered, not dropped.
    sse.emit("rebuild", restartEvent(111));
    expect(
      screen.queryByText(/stopping at next checkpoint/i),
    ).not.toBeInTheDocument();

    // pid arrives: the buffered event is re-evaluated retroactively
    // and the latch trips.
    first.spawn(111);
    expect(
      await screen.findByText(/stopping at next checkpoint/i),
    ).toBeInTheDocument();

    await first.finish(0);
    await waitFor(() => expect(streamTraining).toHaveBeenCalledTimes(2));
  });

  it("user Stop beats a pending auto-restart", async () => {
    const user = userEvent.setup();
    // The handle isn't needed: Stop's abort settles the stream via
    // the mock's abort listener, mirroring a cancelled reader.
    await startRun(111);

    sse.emit("rebuild", restartEvent(111));
    expect(
      await screen.findByText(/stopping at next checkpoint/i),
    ).toBeInTheDocument();

    // Stop aborts the in-flight stream; the abort listener in the
    // mock settles it with `null` like a cancelled reader would.
    await user.click(screen.getByRole("button", { name: /stop training/i }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    // The latch was cleared synchronously by stop(); the aborted
    // branch in run()'s cleanup skips the grace window entirely.
    expect(streamTraining).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/stopping at next checkpoint/i),
    ).not.toBeInTheDocument();
  });

  it("suppresses auto-restart when the run exits nonzero (failed early-stop cancel)", async () => {
    const first = await startRun(111);

    sse.emit("rebuild", restartEvent(111));
    expect(
      await screen.findByText(/stopping at next checkpoint/i),
    ).toBeInTheDocument();

    // exit 143: the runner's early-stop chain failed to cancel the
    // cloud job. Restarting would overlap a fresh cloud job with the
    // un-cancelled one, so the latch must NOT fire.
    await first.finish(143);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(streamTraining).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/auto-restart suppressed/i),
    ).toBeInTheDocument();
  });

  it("suppresses auto-restart when the run ends without an exit status (signal-killed child)", async () => {
    // qodo (round 84): the server's exit marker carries the child's
    // `close` code, which is literally null when the child died to a
    // signal (OS OOM-kill, external SIGKILL); a truncated stream
    // parses to null too. The child never ran its graceful
    // early-stop in either case, so its cloud cancel may not have
    // gone out; a latched restart firing on top would overlap cloud
    // jobs. Only an explicit exit=0 may auto-restart.
    const first = await startRun(111);

    sse.emit("rebuild", restartEvent(111));
    expect(
      await screen.findByText(/stopping at next checkpoint/i),
    ).toBeInTheDocument();

    await first.finish(null);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(streamTraining).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/without an exit status.*auto-restart suppressed/i),
    ).toBeInTheDocument();
  });

  it("suppresses auto-restart when the stream rejects (spawn failure via error= marker)", async () => {
    // qodo (round 83): `streamTraining` now REJECTS on the server's
    // trailing `error=` marker (child spawn failure) instead of
    // resolving `null`. A latched restart must not survive that:
    // re-spawning would just re-run the same failing spawn in a loop.
    const first = await startRun(111);

    sse.emit("rebuild", restartEvent(111));
    expect(
      await screen.findByText(/stopping at next checkpoint/i),
    ).toBeInTheDocument();

    await first.fail("training subprocess failed to start: spawn ENOENT");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(streamTraining).toHaveBeenCalledTimes(1);
    // Both the raw error and the suppression note are surfaced.
    expect(screen.getByText(/spawn ENOENT/)).toBeInTheDocument();
    expect(screen.getByText(/auto-restart suppressed/i)).toBeInTheDocument();
  });

  it("restarts when the matching SSE event lands inside the post-exit grace window", async () => {
    const first = await startRun(111);

    // Stream closes BEFORE the rebuild frame arrives (independent
    // connections can deliver out of order). No latch is set at exit,
    // so run() defers the no-restart decision for ~250 ms.
    await first.finish(0);
    expect(streamTraining).toHaveBeenCalledTimes(1);

    // The late event lands inside the window and still matches the
    // (intentionally preserved) pid.
    sse.emit("rebuild", restartEvent(111));
    await waitFor(() => expect(streamTraining).toHaveBeenCalledTimes(2));
  });

  it("settles to idle when no restart event arrives within the grace window", async () => {
    const first = await startRun(111);
    await first.finish(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(streamTraining).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/restarting with updated code/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the restart latch armed across an intervening HMR error (fix-before-exit flow)", async () => {
    const first = await startRun(111);

    // Rebuild SIGTERMs the child (latch set), then the user's next
    // edit breaks the build. dispatchRebuild skips already-signalled
    // children, so this error (and even the subsequent fixed rebuild)
    // will never re-list our pid: the latch is the only restart
    // signal left and must survive.
    sse.emit("rebuild", restartEvent(111));
    sse.emit("error", { type: "error", message: "syntax error" });

    await first.finish(0);
    await waitFor(() => expect(streamTraining).toHaveBeenCalledTimes(2));
  });

  it("a manual Run during the grace window does not inherit the prior run's restart latch (no phantom auto-restart)", async () => {
    // Leak path under test: run A exits → grace timer armed → a late
    // restart event for A's pid latches → the user clicks Run before
    // the timer fires. The timer's disown branch sees a different
    // current pid and returns; without the run()-entry latch clear,
    // run B would inherit A's stale restart intent and auto-spawn an
    // unrequested job when B finishes (potentially hours later).
    const user = userEvent.setup();
    const first = await startRun(111);
    await first.finish(0);

    // Late event lands inside the 250 ms grace window and latches for
    // run A's pid. The manual click below must land inside the same
    // window (both steps are immediate; the suite's other grace-window
    // tests rely on the same real-timer margin).
    sse.emit("rebuild", restartEvent(111));
    await user.click(screen.getByRole("button", { name: /run training/i }));
    await waitFor(() => expect(streams.length).toBe(2));
    const second = streams[1];
    second.spawn(222);

    // Let A's grace timer fire (disown branch) and settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    await second.finish(0);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    // Exactly two runs: A (manual) and B (manual). A latched restart
    // bleeding into B would have spawned a third.
    expect(streamTraining).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale manifest fetch overwrite a newer HMR error", async () => {
    // First resolve (initial poll) returns the good manifest; the
    // second (rebuild-triggered) is held open so the error frame can
    // overtake it.
    let releaseStale!: (m: ManifestResult) => void;
    vi.mocked(fetchManifest)
      .mockResolvedValueOnce(GOOD_MANIFEST)
      .mockImplementationOnce(
        () =>
          new Promise<ManifestResult>((resolve) => {
            releaseStale = resolve;
          }),
      );

    render(<RunTraining />);
    await screen.findByRole("button", { name: /run training: demo/i });

    // rebuild starts the (slow) manifest re-fetch...
    sse.emit("rebuild", {
      type: "rebuild",
      outFile: "/tmp/x.mjs",
      hash: "h",
      configHash: "h2",
      trainerName: "demo",
    });
    // ...then the user breaks the build before that fetch resolves.
    sse.emit("error", { type: "error", message: "broken build" });
    expect(
      await screen.findByText(/couldn't read manifest: broken build/i),
    ).toBeInTheDocument();

    // The stale fetch finally lands with last-good data. The seq
    // fence must discard it: the error stays on screen and the Run
    // button stays disabled-by-error rather than re-enabling against
    // stale code.
    await act(async () => {
      releaseStale(GOOD_MANIFEST);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      screen.getByText(/couldn't read manifest: broken build/i),
    ).toBeInTheDocument();
  });
});
