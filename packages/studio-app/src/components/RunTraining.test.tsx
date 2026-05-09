// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunTraining } from "./RunTraining";
import { jsonResponse, textStreamResponse } from "../test-utils/responses";

const ORIG_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
});

describe("<RunTraining />", () => {
  it("hints that no trainer is wired up when the manifest has none", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/manifest")
        return jsonResponse({ trainer: null });
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    render(<RunTraining />);
    expect(await screen.findByText(/no trainer in/i)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /run training/i });
    expect(btn).toBeDisabled();
  });

  it("surfaces a manifest error inline", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/manifest")
        return new Response(
          JSON.stringify({ error: "src/arkor/index.ts not found" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    render(<RunTraining />);
    expect(
      await screen.findByText(/couldn't read manifest/i),
    ).toBeInTheDocument();
  });

  it("enables the run button and shows the trainer name when the manifest exposes one", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/manifest")
        return jsonResponse({ trainer: { name: "demo-trainer" } });
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    render(<RunTraining />);
    const btn = await screen.findByRole("button", {
      name: /run training: demo-trainer/i,
    });
    expect(btn).toBeEnabled();
  });

  it("renders training errors inline when /api/train throws", async () => {
    // RunTraining's catch branch appends `[error] <message>` to the
    // log pane and flips the button back to idle. A regression in
    // either half would silently swallow trainer-side failures.
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/manifest")
        return jsonResponse({ trainer: { name: "demo-trainer" } });
      if (url === "/api/train") throw new Error("network down");
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<RunTraining />);
    const runBtn = await screen.findByRole("button", {
      name: /run training: demo-trainer/i,
    });
    await user.click(runBtn);

    expect(
      await screen.findByText(/\[error\] network down/i),
    ).toBeInTheDocument();
    // Button returns to the idle label once the catch branch settles.
    await screen.findByRole("button", {
      name: /run training: demo-trainer/i,
    });
  });

  it("streams trainer output into the log pane on click", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/manifest")
        return jsonResponse({ trainer: { name: "demo-trainer" } });
      if (url === "/api/train")
        return textStreamResponse(["hello ", "world\n"]);
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<RunTraining />);
    const runBtn = await screen.findByRole("button", {
      name: /run training: demo-trainer/i,
    });
    await user.click(runBtn);

    expect(await screen.findByText(/hello world/)).toBeInTheDocument();
    // The button toggles back to the idle label once the stream closes.
    await screen.findByRole("button", { name: /run training: demo-trainer/i });
  });

  it("polls /api/manifest every 5s and reflects a trainer added mid-session", async () => {
    // RunTraining chains setTimeout(tick, 5000) instead of setInterval so
    // a slow /api/manifest can't pile up overlapping calls. The point of
    // the polling loop is that adding `createTrainer(...)` to
    // src/arkor/index.ts mid-session enables the Run button without a
    // page reload; verify both halves (the second fetch fires and the
    // button label updates) so a regression to setInterval or to the
    // wrong dependency wiring is caught here.
    vi.useFakeTimers();
    try {
      let manifestCalls = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/manifest") {
          manifestCalls++;
          if (manifestCalls === 1) return jsonResponse({ trainer: null });
          return jsonResponse({ trainer: { name: "late-trainer" } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch;

      render(<RunTraining />);
      await vi.advanceTimersByTimeAsync(0);
      expect(manifestCalls).toBe(1);
      expect(
        screen.getByRole("button", { name: /run training/i }),
      ).toBeDisabled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(manifestCalls).toBe(2);

      const enabled = screen.getByRole("button", {
        name: /run training: late-trainer/i,
      });
      expect(enabled).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the in-flight stream when the user clicks Stop training", async () => {
    const user = userEvent.setup();
    let cancelled = false;
    const enc = new TextEncoder();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/manifest")
        return jsonResponse({ trainer: { name: "demo-trainer" } });
      if (url === "/api/train") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("starting...\n"));
            // Never close: the stream stays open until the caller
            // cancels it via the abort signal. That mirrors the real
            // trainer process, which keeps streaming until stopped.
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<RunTraining />);
    const runBtn = await screen.findByRole("button", {
      name: /run training: demo-trainer/i,
    });
    await user.click(runBtn);

    // Wait for the first chunk to land and the button to flip into Stop mode.
    expect(await screen.findByText(/starting\.\.\./)).toBeInTheDocument();
    const stopBtn = await screen.findByRole("button", {
      name: /stop training/i,
    });
    await user.click(stopBtn);

    // The button returns to the idle label and the underlying body reader
    // gets cancelled so no trainer process leaks.
    await waitFor(() => {
      expect(cancelled).toBe(true);
    });
    await screen.findByRole("button", { name: /run training: demo-trainer/i });
  });
});
