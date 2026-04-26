import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractInferenceDelta, streamInferenceContent } from "./api";

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
