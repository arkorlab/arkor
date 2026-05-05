import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Overview } from "./Overview";
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

interface RouteResponses {
  jobs?: Response | (() => Response);
  manifest?: Response | (() => Response);
}

function mockFetchByRoute(routes: RouteResponses) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const pick = (entry?: Response | (() => Response)) =>
      typeof entry === "function" ? entry() : entry;
    if (url === "/api/jobs") {
      const r = pick(routes.jobs);
      if (r) return r;
    }
    if (url === "/api/manifest") {
      const r = pick(routes.manifest);
      if (r) return r;
    }
    throw new Error(`Unexpected fetch in Overview test: ${url}`);
  }) as typeof fetch;
}

const ORIG_FETCH = globalThis.fetch;

describe("<Overview />", () => {
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    globalThis.fetch = mockFetchByRoute({
      jobs: () => jsonResponse({ jobs: [] }),
      manifest: () => jsonResponse({ trainer: null }),
    });
  });

  it("shows the heading and quick-start tiles", async () => {
    render(<Overview />);
    expect(
      screen.getByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Documentation")).toBeInTheDocument();
    expect(screen.getByText("Open the Playground")).toBeInTheDocument();
  });

  it("renders the recent jobs list when /api/jobs returns rows", async () => {
    globalThis.fetch = mockFetchByRoute({
      jobs: () =>
        jsonResponse({
          jobs: [
            makeJob({ id: "j-1", name: "first-run", status: "running" }),
            makeJob({ id: "j-2", name: "second-run", status: "completed" }),
          ],
        }),
      manifest: () => jsonResponse({ trainer: null }),
    });
    render(<Overview />);
    expect(await screen.findByText("first-run")).toBeInTheDocument();
    expect(screen.getByText("second-run")).toBeInTheDocument();
  });

  it("caps the recent jobs list at five rows", async () => {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      makeJob({ id: `j-${i}`, name: `run-${i}`, status: "completed" }),
    );
    globalThis.fetch = mockFetchByRoute({
      jobs: () => jsonResponse({ jobs }),
      manifest: () => jsonResponse({ trainer: null }),
    });
    render(<Overview />);
    expect(await screen.findByText("run-0")).toBeInTheDocument();
    expect(screen.getByText("run-4")).toBeInTheDocument();
    expect(screen.queryByText("run-5")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no jobs yet", async () => {
    render(<Overview />);
    expect(await screen.findByText(/no jobs yet/i)).toBeInTheDocument();
  });

  it("surfaces the error banner when /api/jobs fails", async () => {
    globalThis.fetch = mockFetchByRoute({
      jobs: () =>
        new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      manifest: () => jsonResponse({ trainer: null }),
    });
    render(<Overview />);
    expect(
      await screen.findByText(/failed to load jobs/i),
    ).toBeInTheDocument();
  });

  it("renders the trainer name on the run-training button when the manifest exposes one", async () => {
    globalThis.fetch = mockFetchByRoute({
      jobs: () => jsonResponse({ jobs: [] }),
      manifest: () => jsonResponse({ trainer: { name: "my-trainer" } }),
    });
    render(<Overview />);
    expect(
      await screen.findByRole("button", { name: /run training: my-trainer/i }),
    ).toBeInTheDocument();
  });
});
