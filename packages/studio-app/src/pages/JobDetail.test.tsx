// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { jsonResponse } from "../test-utils/responses";

import { JobDetail } from "./JobDetail";

import type { Job } from "../lib/api";

const ORIG_FETCH = globalThis.fetch;

/**
 * `openJobEvents` builds an EventSource, which jsdom does not implement.
 * The stub records listeners so a test can deliver a frame, and is enough
 * for the status-precedence assertions here (the streaming behaviour has
 * its own coverage in the Playwright suite).
 */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  private readonly listeners = new Map<
    string,
    ((ev: MessageEvent) => void)[]
  >();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {
    // no-op: the component only removes on unmount
  }
  close(): void {
    // no-op
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "j1",
    name: "run",
    status: "cancelled",
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("<JobDetail />", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = ORIG_FETCH;
  });

  it("shows a cancelled run as cancelled even when the SSE frame says failed", async () => {
    // The stream contract has no cancellation event: cancelling emits
    // `training.failed`. A producer whose wording differs from the
    // sentinel must still not leave the page reporting a failure, because
    // the polled record settles on "cancelled".
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ jobs: [job()] }),
    ) as typeof fetch;

    render(<JobDetail jobId="j1" local={false} />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("training.failed", {
      error: "stopped by operator",
      timestamp: "2026-04-01T00:05:00Z",
    });

    // The status badge and the sidebar's status row both render the
    // label; either one showing "Cancelled" proves the precedence.
    await waitFor(() =>
      expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/Job failed:/)).not.toBeInTheDocument();
  });

  it("keeps a genuine failure visible", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ jobs: [job({ status: "failed" })] }),
    ) as typeof fetch;

    render(<JobDetail jobId="j1" local={false} />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.emit("training.failed", {
      error: "CUDA OOM",
      timestamp: "2026-04-01T00:05:00Z",
    });

    // The banner (not the raw event row, which also carries the text).
    expect(await screen.findByText(/Job failed:/)).toBeInTheDocument();
    expect(screen.getAllByText(/CUDA OOM/).length).toBeGreaterThan(0);
  });

  it("hides the Playground action until the local mode is known", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        jobs: [job({ status: "completed", config: { dryRun: true } })],
      }),
    ) as typeof fetch;

    const { rerender } = render(<JobDetail jobId="j1" />);
    // Wait for the POLLED record: without it `status` is still "queued"
    // and the button would be hidden for that reason instead of the one
    // under test.
    await waitFor(() =>
      expect(screen.getAllByText("Completed").length).toBeGreaterThan(0),
    );
    // Mode unresolved: no link that might resolve to nothing.
    expect(
      screen.queryByRole("button", { name: /Open in Playground/ }),
    ).not.toBeInTheDocument();

    // Cloud dry runs do produce an adapter, so the action appears there.
    rerender(<JobDetail jobId="j1" local={false} />);
    expect(
      await screen.findByRole("button", { name: /Open in Playground/ }),
    ).toBeInTheDocument();

    // Local dry runs do not.
    rerender(<JobDetail jobId="j1" local />);
    expect(
      screen.queryByRole("button", { name: /Open in Playground/ }),
    ).not.toBeInTheDocument();
  });
});
