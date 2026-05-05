// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
});
