// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobsList } from "./JobsList";
import { jsonResponse } from "../test-utils/responses";
import type { Job } from "../lib/api";

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: "j-default",
    name: "default",
    status: "running",
    createdAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

const ORIG_FETCH = globalThis.fetch;

describe("<JobsList />", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        jobs: [
          makeJob({ id: "j-alpha", name: "alpha-run", status: "running" }),
          makeJob({ id: "j-beta", name: "beta-run", status: "completed" }),
        ],
      }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.restoreAllMocks();
  });

  it("renders the jobs returned by /api/jobs", async () => {
    render(<JobsList />);
    expect(await screen.findByText("alpha-run")).toBeInTheDocument();
    expect(screen.getByText("beta-run")).toBeInTheDocument();
  });

  it("filters rows when the user types into the search box", async () => {
    const user = userEvent.setup();
    render(<JobsList />);
    await screen.findByText("alpha-run");

    await user.type(
      screen.getByRole("searchbox", { name: /search jobs/i }),
      "alpha",
    );

    expect(screen.getByText("alpha-run")).toBeInTheDocument();
    expect(screen.queryByText("beta-run")).not.toBeInTheDocument();
  });

  it("filters rows when a status chip is selected", async () => {
    const user = userEvent.setup();
    render(<JobsList />);
    await screen.findByText("alpha-run");

    const filterGroup = screen.getByRole("group", { name: /filter by status/i });
    await user.click(within(filterGroup).getByRole("button", { name: "Completed" }));

    expect(screen.queryByText("alpha-run")).not.toBeInTheDocument();
    expect(screen.getByText("beta-run")).toBeInTheDocument();
  });

  it("shows the empty state when /api/jobs returns no jobs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ jobs: [] }),
    ) as typeof fetch;
    render(<JobsList />);
    expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
  });

  it("shows the error banner when /api/jobs fails", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("nope", { status: 503, statusText: "Service Unavailable" }),
    ) as typeof fetch;
    render(<JobsList />);
    expect(
      await screen.findByText(/failed to load jobs/i),
    ).toBeInTheDocument();
  });

  it("refetches /api/jobs when the Refresh button is clicked", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        jobs: [makeJob({ id: "j-1", name: "first", status: "running" })],
      }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    const user = userEvent.setup();
    render(<JobsList />);
    await screen.findByText("first");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("polls /api/jobs every 5 seconds via the chained timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => jsonResponse({ jobs: [] }));
      globalThis.fetch = fetchSpy as typeof fetch;
      render(<JobsList />);

      // Flush the initial microtask chain so the first fetch settles
      // and `setTimeout(schedule, 5000)` actually gets installed.
      // `advanceTimersByTimeAsync(0)` runs the queued microtasks
      // without bumping any timers; `waitFor` would hang here because
      // it leans on wall-clock setTimeout, which is fake under us.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues a Refresh click that lands while a poll tick is in flight", async () => {
    // The polling tick installs its fetch and awaits it; if the user
    // clicks Refresh during that window, inFlightRef short-circuits the
    // second call but pendingManualRef captures the intent so a
    // follow-up fetch fires the moment the in-flight tick settles.
    // Stalling the first fetch with a manually-resolved promise lets
    // us observe both halves of that handshake without leaning on
    // wall-clock timing.
    const calls: { resolve: (v: Response) => void }[] = [];
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          calls.push({ resolve });
        }),
    ) as typeof fetch;

    const user = userEvent.setup();
    render(<JobsList />);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    await user.click(refreshButton);
    // The click should flip the spinner up immediately even though
    // inFlightRef has us coalesced into the in-flight tick.
    await waitFor(() => {
      expect(refreshButton).toBeDisabled();
    });
    expect(calls).toHaveLength(1);

    // Settle the in-flight tick. The pendingManualRef branch should
    // then queue a follow-up fetch from inside the finally block.
    calls[0]!.resolve(jsonResponse({ jobs: [] }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });

    // Resolve the queued manual follow-up so React's effects can settle
    // cleanly before the test tears down.
    calls[1]!.resolve(jsonResponse({ jobs: [] }));
    await waitFor(() => {
      expect(refreshButton).toBeEnabled();
    });
  });
});
