import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  apiFetch,
  extractInferenceDelta,
  redactPath,
  streamInferenceContent,
} from "./api";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("./telemetry", () => ({
  track: trackMock,
  trackPageView: vi.fn(),
  captureException: vi.fn(),
  initTelemetry: vi.fn(async () => {}),
}));

describe("extractInferenceDelta", () => {
  it("pulls OpenAI-style streaming deltas from choices[0].delta.content", () => {
    const data = JSON.stringify({
      choices: [{ delta: { content: "hello" } }],
    });
    expect(extractInferenceDelta(data)).toBe("hello");
  });

  it("falls back to top-level `content` when present", () => {
    expect(extractInferenceDelta(JSON.stringify({ content: "hi" }))).toBe("hi");
  });

  it("falls back to top-level `text` when present", () => {
    expect(extractInferenceDelta(JSON.stringify({ text: "hey" }))).toBe("hey");
  });

  it("returns the raw data when it isn't JSON (so users still see something)", () => {
    expect(extractInferenceDelta("not-json")).toBe("not-json");
  });

  it("treats JSON-string frames as token content (regression for codex review)", () => {
    // Some providers/proxies serialize token chunks as `data: "Hel"`
    // (a JSON string, not an object). Previously these parsed as a
    // string, hit the `typeof parsed !== "object"` branch, and returned
    // null — leaving the assistant bubble silently empty.
    expect(extractInferenceDelta('"Hel"')).toBe("Hel");
    expect(extractInferenceDelta('""')).toBe("");
  });

  it("returns null for an empty data line", () => {
    expect(extractInferenceDelta("")).toBeNull();
  });

  it("returns null for a JSON object with no recognised content field", () => {
    expect(extractInferenceDelta(JSON.stringify({ usage: {} }))).toBeNull();
  });

  it("ignores empty choices arrays", () => {
    expect(extractInferenceDelta(JSON.stringify({ choices: [] }))).toBeNull();
  });

  it("ignores choices entries that aren't objects", () => {
    expect(
      extractInferenceDelta(JSON.stringify({ choices: ["nope"] })),
    ).toBeNull();
  });
});

// Mount a SSE-shaped Response from a list of frames and let the SPA's
// stream consumer assemble the assistant text. Regression for ENG-358 —
// the previous Playground code concatenated raw `data: …\n\n` frames
// straight into the message bubble.
describe("streamInferenceContent (regression for ENG-358)", () => {
  const ORIG_FETCH = globalThis.fetch;

  function mockSseResponse(frames: string[]): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  beforeEach(() => {
    // The token meta tag isn't present in the vitest DOM; apiFetch will
    // still send a request without the header, which is fine for a fetch
    // mock that doesn't check it.
    globalThis.fetch = vi.fn(async () =>
      mockSseResponse([
        `event: token\ndata: ${JSON.stringify({
          choices: [{ delta: { content: "Hel" } }],
        })}\n\n`,
        `event: token\ndata: ${JSON.stringify({
          choices: [{ delta: { content: "lo" } }],
        })}\n\n`,
        `event: end\ndata: \n\n`,
      ]),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  it("yields decoded text fragments, never raw SSE frame text", async () => {
    const fragments: string[] = [];
    for await (const f of streamInferenceContent({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) {
      fragments.push(f);
    }
    expect(fragments).toEqual(["Hel", "lo"]);
    // The bug emitted things like `data: {"choices":...}` into the bubble.
    for (const f of fragments) {
      expect(f).not.toMatch(/^data:|^event:/);
    }
  });

  it("stops cleanly on the `end` sentinel", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockSseResponse([
        `event: token\ndata: ${JSON.stringify({ content: "first" })}\n\n`,
        `event: end\ndata: \n\n`,
        // anything after `end` should be ignored
        `event: token\ndata: ${JSON.stringify({ content: "should-not-appear" })}\n\n`,
      ]),
    ) as typeof fetch;

    const fragments: string[] = [];
    for await (const f of streamInferenceContent({
      messages: [],
      stream: true,
    })) {
      fragments.push(f);
    }
    expect(fragments).toEqual(["first"]);
  });

  it("throws when /api/inference/chat returns 2xx with no body (regression for codex review)", async () => {
    // A successful response without a body (e.g. 204, or an upstream that
    // closed cleanly without writing any frames) used to surface as
    // `Error("No response body")` in the Playground. After the SSE rewrite
    // the silent-exit branch in `iterateSseFrames` would have left the
    // assistant bubble empty with no feedback — guard against that.
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as typeof fetch;

    const consume = (async () => {
      for await (const _ of streamInferenceContent({
        messages: [],
        stream: true,
      })) {
        // not expected to yield
      }
    })();

    await expect(consume).rejects.toThrow(/no body/i);
  });

  it("throws with the upstream body when /api/inference/chat returns non-2xx", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("upstream blew up", { status: 502 }),
    ) as typeof fetch;

    const consume = (async () => {
      const fragments: string[] = [];
      for await (const f of streamInferenceContent({
        messages: [],
        stream: true,
      })) {
        fragments.push(f);
      }
      return fragments;
    })();

    await expect(consume).rejects.toThrow(/upstream blew up/);
  });
});

describe("redactPath", () => {
  it("replaces UUID-like segments with :id", () => {
    expect(redactPath("/api/jobs/123e4567-e89b-12d3-a456-426614174000/events")).toBe(
      "/api/jobs/:id/events",
    );
  });

  it("replaces long hex-id segments with :id", () => {
    expect(redactPath("/api/jobs/a1b2c3d4e5f6a7b8c9d0/events")).toBe(
      "/api/jobs/:id/events",
    );
  });

  it("strips query strings (CSRF token leak guard)", () => {
    expect(redactPath("/api/jobs/abc/events?studioToken=secret")).toBe(
      "/api/jobs/abc/events",
    );
  });

  it("leaves short slug segments alone", () => {
    expect(redactPath("/api/credentials")).toBe("/api/credentials");
  });

  it("strips scheme and host for absolute URLs so the path is parsed cleanly", () => {
    expect(
      redactPath(
        "https://api.arkor.ai/v1/jobs/123e4567-e89b-12d3-a456-426614174000/events?token=secret",
      ),
    ).toBe("/v1/jobs/:id/events");
  });

  it("falls back gracefully for unparseable absolute-looking URLs", () => {
    // Best effort: don't throw, don't tokenise the scheme. An unparseable
    // URL falls through to raw input handling.
    expect(redactPath("https://")).toBe("https://");
  });
});

describe("apiFetch error capture", () => {
  const ORIG_FETCH = globalThis.fetch;

  beforeEach(() => {
    trackMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  it("fires studio_api_error with redacted endpoint on non-OK responses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Boom" }),
    ) as typeof fetch;
    await apiFetch(
      "/api/jobs/123e4567-e89b-12d3-a456-426614174000/events?studioToken=x",
    );
    expect(trackMock).toHaveBeenCalledWith("studio_api_error", {
      endpoint: "/api/jobs/:id/events",
      method: "GET",
      status: 500,
      status_text: "Boom",
    });
  });

  it("does not fire studio_api_error on 2xx responses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as typeof fetch;
    await apiFetch("/api/credentials");
    expect(trackMock).not.toHaveBeenCalled();
  });
});
