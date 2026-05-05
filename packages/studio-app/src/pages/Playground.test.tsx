import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Playground } from "./Playground";
import {
  jsonResponse,
  sseResponse,
  sseDeltaFrame,
} from "../test-utils/responses";

const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  // Some Playground children call scrollTo on textarea / message list.
  // jsdom doesn't implement it; stub so the layout effects don't throw.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
  // Reset hash so successive tests don't inherit `?adapter=...` state
  // from URL syncing in earlier cases.
  window.history.replaceState(null, "", "/");
});

describe("<Playground />", () => {
  it("renders the empty state once /api/jobs resolves", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/jobs") return jsonResponse({ jobs: [] });
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    render(<Playground />);
    expect(
      await screen.findByText(/ready when you are/i),
    ).toBeInTheDocument();
  });

  it("falls back to base mode and shows the error banner when /api/jobs fails", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/jobs")
        return new Response("nope", { status: 503, statusText: "Service Unavailable" });
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    render(<Playground />);
    expect(
      await screen.findByText(/failed to load jobs/i),
    ).toBeInTheDocument();
    // Composer must still be available in base mode despite the failure.
    expect(screen.getByLabelText("Message")).toBeEnabled();
  });

  it("streams assistant fragments into a new bubble after the user sends a message", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/jobs") return jsonResponse({ jobs: [] });
      if (url === "/api/inference/chat")
        return sseResponse([
          sseDeltaFrame("Hel"),
          sseDeltaFrame("lo"),
          `event: end\ndata: \n\n`,
        ]);
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<Playground />);
    await screen.findByText(/ready when you are/i);

    const composer = screen.getByLabelText("Message");
    await user.type(composer, "ping");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText("ping")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
  });

  it("surfaces upstream errors as an inline assistant bubble", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/jobs") return jsonResponse({ jobs: [] });
      if (url === "/api/inference/chat")
        return new Response("upstream blew up", { status: 502 });
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<Playground />);
    await screen.findByText(/ready when you are/i);

    const composer = screen.getByLabelText("Message");
    await user.type(composer, "boom");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(
      await screen.findByText(/\[error\] upstream blew up/i),
    ).toBeInTheDocument();
  });
});
