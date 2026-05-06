// @vitest-environment jsdom
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
// Snapshot scrollTo so we can restore it in afterEach. `vi.restoreAllMocks()`
// only undoes spies; a direct prototype assignment would otherwise leak the
// mock into any later suite that expected jsdom's native behaviour (or its
// absence). `hadScrollTo` distinguishes "jsdom didn't define it" from "jsdom
// did define it as undefined" so the teardown can `delete` rather than write
// `undefined`, which would otherwise leave an own property on the prototype
// detectable via `'scrollTo' in Element.prototype`.
const HAD_SCROLL_TO = Object.prototype.hasOwnProperty.call(
  Element.prototype,
  "scrollTo",
);
const ORIG_SCROLL_TO = Element.prototype.scrollTo;

beforeEach(() => {
  // Some Playground children call scrollTo on textarea / message list.
  // jsdom doesn't implement it; stub so the layout effects don't throw.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (HAD_SCROLL_TO) {
    Element.prototype.scrollTo = ORIG_SCROLL_TO;
  } else {
    delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  }
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

  describe("adapter mode", () => {
    it("opens directly in adapter mode when initialAdapterId is supplied", async () => {
      // Reaching Playground via "Open in Playground" from JobDetail
      // seeds the URL with `#/playground?adapter=<id>` and the route
      // layer hands the id in as `initialAdapterId`. The page should
      // render the adapter-mode subtitle instead of base-model copy.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/jobs")
          return jsonResponse({
            jobs: [
              {
                id: "job-completed",
                name: "completed-run",
                status: "completed",
                createdAt: "2026-04-01T00:00:00Z",
              },
            ],
          });
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }) as typeof fetch;

      render(<Playground initialAdapterId="job-completed" />);
      expect(
        await screen.findByText(/chat with a completed adapter/i),
      ).toBeInTheDocument();
    });

    it("shows the loading state while /api/jobs is in flight in adapter mode", async () => {
      // Stall /api/jobs so the page never gets past `jobs === null`.
      // The adapter branch must surface a Loading state rather than
      // the misleading "No completed jobs yet" empty state, which is
      // only honest once we know the list is really empty.
      globalThis.fetch = vi.fn(
        () => new Promise<Response>(() => {}),
      ) as typeof fetch;

      render(<Playground initialAdapterId="job-completed" />);
      expect(await screen.findByText(/loading jobs/i)).toBeInTheDocument();
    });

    it("shows the no-completed-jobs empty state when /api/jobs returns nothing in adapter mode", async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/jobs") return jsonResponse({ jobs: [] });
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }) as typeof fetch;

      render(<Playground initialAdapterId="job-completed" />);
      expect(
        await screen.findByText(/no completed jobs yet/i),
      ).toBeInTheDocument();
    });

    it("writes the selected adapter id back into the URL hash", async () => {
      // Picking an adapter mirrors `mode` and the selected job id into
      // the URL hash via replaceState, so a reload or copy-paste lands
      // on the same view. Verify the hash matches once the picker
      // selects a different adapter.
      const user = userEvent.setup();
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/jobs")
          return jsonResponse({
            jobs: [
              {
                id: "job-a",
                name: "alpha",
                status: "completed",
                createdAt: "2026-04-01T00:00:00Z",
              },
              {
                id: "job-b",
                name: "bravo",
                status: "completed",
                createdAt: "2026-04-02T00:00:00Z",
              },
            ],
          });
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }) as typeof fetch;

      render(<Playground initialAdapterId="job-a" />);
      await screen.findByText(/chat with a completed adapter/i);
      // The URL starts at `/`; the page itself doesn't push the
      // initial id (the route layer does), but selecting a different
      // adapter must mirror the new id into the hash.
      const adapterSelect = await screen.findByRole("combobox", {
        name: "Adapter",
      });
      await user.selectOptions(adapterSelect, "job-b");

      await waitFor(() => {
        expect(window.location.hash).toBe("#/playground?adapter=job-b");
      });
    });
  });
});
