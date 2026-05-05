import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("aborts the in-flight stream when the user clicks Stop training", async () => {
    const user = userEvent.setup();
    let cancelled = false;
    const enc = new TextEncoder();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/manifest")
        return jsonResponse({ trainer: { name: "demo-trainer" } });
      if (url === "/api/train") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("starting...\n"));
            // Intentionally never close — the stream stays open until the
            // caller cancels it via the abort signal. That's the realistic
            // shape of the trainer process: it keeps streaming until the
            // user stops it.
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
          // Mirror the real abort behaviour: streamTraining wires an
          // abort listener through to reader.cancel(), which surfaces
          // here as the cancel callback firing.
        });
        void init;
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
