import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractInferenceDelta,
  fetchCredentials,
  fetchJobs,
  fetchManifest,
  fetchMe,
  streamInferenceContent,
  streamTraining,
} from "./api";

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

describe("apiFetch JSON helpers", () => {
  const ORIG_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.restoreAllMocks();
  });

  it("fetchCredentials parses the credentials envelope", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      seenUrls.push(String(input));
      return new Response(
        JSON.stringify({
          token: "studio-tok",
          mode: "anon",
          baseUrl: "http://mock-cloud-api",
          orgSlug: "anon-abc",
          projectSlug: null,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const creds = await fetchCredentials();
    expect(seenUrls).toEqual(["/api/credentials"]);
    expect(creds).toEqual({
      token: "studio-tok",
      mode: "anon",
      baseUrl: "http://mock-cloud-api",
      orgSlug: "anon-abc",
      projectSlug: null,
    });
  });

  it("fetchMe returns the parsed user + orgs envelope", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { id: "u1" },
            orgs: [{ slug: "a" }, { slug: "b" }],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const me = await fetchMe();
    expect(me.user).toEqual({ id: "u1" });
    expect(me.orgs).toHaveLength(2);
  });

  it("fetchJobs returns the parsed jobs list", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: "j1",
                name: "run",
                status: "running",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const { jobs } = await fetchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe("j1");
  });

  it("apiFetch helpers throw with the status text on non-ok responses", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("nope", { status: 503, statusText: "Service Unavailable" }),
    ) as typeof fetch;
    await expect(fetchMe()).rejects.toThrow(/503/);
    await expect(fetchJobs()).rejects.toThrow(/503/);
  });
});

describe("fetchManifest", () => {
  const ORIG_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.restoreAllMocks();
  });

  it("returns the manifest summary on 200", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ trainer: { name: "my-run" } }), {
          status: 200,
        }),
    ) as typeof fetch;
    const m = await fetchManifest();
    expect(m).toEqual({ trainer: { name: "my-run" } });
  });

  it("returns the structured error envelope on 400 (e.g. missing src/arkor/index.ts)", async () => {
    // The SPA renders this error inline as a hint instead of a generic
    // failure — the helper must therefore distinguish 400 from other 4xx.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "src/arkor/index.ts not found" }),
          { status: 400 },
        ),
    ) as typeof fetch;
    const m = await fetchManifest();
    expect(m).toEqual({ error: "src/arkor/index.ts not found" });
  });

  it("throws on non-400 4xx/5xx errors", async () => {
    // 401 is a real auth failure; surfacing it as `{ error }` would mask
    // the credential problem behind the manifest tile.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("forbidden", {
          status: 403,
          statusText: "Forbidden",
        }),
    ) as typeof fetch;
    await expect(fetchManifest()).rejects.toThrow(/403/);
  });
});

describe("streamTraining", () => {
  const ORIG_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.restoreAllMocks();
  });

  function mockChunkedResponse(chunks: string[]): Response {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const x of chunks) c.enqueue(enc.encode(x));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/plain" } },
    );
  }

  it("streams chunks to onChunk in order until the body closes", async () => {
    globalThis.fetch = vi.fn(
      async () => mockChunkedResponse(["one ", "two ", "three"]),
    ) as typeof fetch;
    const received: string[] = [];
    await streamTraining((t) => received.push(t));
    expect(received.join("")).toBe("one two three");
  });

  it("forwards the file argument to /api/train when supplied", async () => {
    let captured: { url: string; body: string } = { url: "", body: "" };
    globalThis.fetch = vi.fn(async (input, init) => {
      captured = {
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      };
      return mockChunkedResponse([]);
    }) as typeof fetch;
    await streamTraining(() => undefined, "src/arkor/trainer.ts");
    expect(captured.url).toBe("/api/train");
    expect(JSON.parse(captured.body)).toEqual({ file: "src/arkor/trainer.ts" });
  });

  it("omits the file field when no path is supplied", async () => {
    let captured = "";
    globalThis.fetch = vi.fn(async (_, init) => {
      captured = typeof init?.body === "string" ? init.body : "";
      return mockChunkedResponse([]);
    }) as typeof fetch;
    await streamTraining(() => undefined);
    expect(JSON.parse(captured)).toEqual({});
  });

  it("returns silently when the response has no body (e.g. 204 from upstream)", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as typeof fetch;
    const received: string[] = [];
    await streamTraining((t) => received.push(t));
    expect(received).toEqual([]);
  });
});
