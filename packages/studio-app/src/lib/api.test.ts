import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractInferenceDelta,
  fetchCredentials,
  fetchJobs,
  fetchManifest,
  fetchMe,
  isHmrEnabled,
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

  it("flushes the TextDecoder so a multi-byte UTF-8 sequence split across chunks isn't dropped", async () => {
    // The ideograph "あ" encodes to 0xE3 0x81 0x82 in UTF-8. Split it
    // across two chunks: the first chunk's `decode(..., {stream:true})`
    // returns "" (incomplete code point buffered); without a final
    // `decode()` flush after the loop, the trailing bytes would be
    // silently discarded and the user would see truncated trainer
    // output for any non-ASCII tail.
    const enc = new Uint8Array([0xe3, 0x81, 0x82]);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.slice(0, 2));
              c.enqueue(enc.slice(2));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
    ) as typeof fetch;
    const received: string[] = [];
    await streamTraining((t) => received.push(t));
    expect(received.join("")).toBe("あ");
  });

  it("threads the AbortSignal into apiFetch", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn(async (_, init) => {
      receivedSignal = init?.signal as AbortSignal | null | undefined;
      return mockChunkedResponse([]);
    }) as typeof fetch;
    const ac = new AbortController();
    await streamTraining(() => undefined, undefined, ac.signal);
    expect(receivedSignal).toBe(ac.signal);
  });

  it("cancels the body reader and skips the read loop when the signal is already aborted", async () => {
    // Track whether reader.cancel() was reached. Using a never-closing
    // ReadableStream means the read loop would hang forever if the
    // pre-aborted check doesn't bail; the test would time out instead
    // of completing. The cancel call also resolves the stream so we
    // get a clean teardown.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      // intentionally no enqueue / no close — would block on read()
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ) as typeof fetch;

    const ac = new AbortController();
    ac.abort();
    const received: string[] = [];
    await streamTraining((t) => received.push(t), undefined, ac.signal);
    expect(received).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it("cancels the body reader when the signal aborts mid-stream", async () => {
    // The stream pushes one chunk and then blocks (no further enqueue,
    // no close). If the abort listener doesn't wire reader.cancel()
    // through to the underlying source, this test hangs and times out.
    // The `cancelled` flag confirms the cancel reached the source and
    // `received === ["first "]` confirms no subsequent chunks slipped
    // in after the abort.
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("first "));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ) as typeof fetch;

    const ac = new AbortController();
    const received: string[] = [];
    await streamTraining(
      (t) => {
        received.push(t);
        // Trigger abort right after the first chunk lands; the next
        // read() will resolve via the abort listener's reader.cancel()
        // which terminates the loop with `done: true`.
        if (received.length === 1) ac.abort();
      },
      undefined,
      ac.signal,
    );
    expect(received).toEqual(["first "]);
    expect(cancelled).toBe(true);
  });
});

describe("streamInferenceContent abort", () => {
  const ORIG_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.restoreAllMocks();
  });

  it("threads the AbortSignal into apiFetch", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const enc = new TextEncoder();
    globalThis.fetch = vi.fn(async (_, init) => {
      receivedSignal = init?.signal as AbortSignal | null | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`event: end\ndata: \n\n`));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const ac = new AbortController();
    const consume = (async () => {
      for await (const _ of streamInferenceContent(
        { messages: [], stream: true },
        ac.signal,
      )) {
        // drain
      }
    })();
    await consume;
    expect(receivedSignal).toBe(ac.signal);
  });

  it("propagates fetch's AbortError when the signal is already aborted", async () => {
    // When apiFetch sees an aborted signal it rejects with the runtime's
    // AbortError. The streamInferenceContent generator should surface
    // that as a thrown exception so the Playground's try/catch can run
    // its `if (ac.signal.aborted) return;` branch.
    globalThis.fetch = vi.fn(async (_, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const ac = new AbortController();
    ac.abort();
    const consume = (async () => {
      for await (const _ of streamInferenceContent(
        { messages: [], stream: true },
        ac.signal,
      )) {
        // not expected to yield
      }
    })();
    await expect(consume).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("isHmrEnabled", () => {
  // Regression: a previous version of `RunTraining` gated its
  // EventSource subscription on `import.meta.env.DEV`, which is
  // baked to `false` by `vite build` and therefore *always* false
  // in a real `arkor dev` session (the SPA is shipped as static
  // assets). The new server-side `<meta name="arkor-hmr-enabled">`
  // tag is what tells the SPA whether HMR is actually wired in;
  // these tests pin the contract.
  //
  // The package's vitest config doesn't load jsdom (the rest of the
  // suite runs in Node), so we stub the minimal `document` API
  // `isHmrEnabled` uses — `querySelector('meta[name=...]')` —
  // directly on `globalThis`. The reader's contract is just "look
  // up a meta tag and return its content === 'true'", which a tiny
  // hand-rolled stub covers without dragging the whole DOM in.
  function withMetaContent(value: string | null, fn: () => void) {
    const fakeDocument = {
      querySelector: (selector: string) => {
        if (selector !== 'meta[name="arkor-hmr-enabled"]') return null;
        if (value === null) return null;
        return { getAttribute: () => value };
      },
    };
    const had = "document" in globalThis;
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = fakeDocument;
    try {
      fn();
    } finally {
      if (had) (globalThis as { document?: unknown }).document = previous;
      else delete (globalThis as { document?: unknown }).document;
    }
  }

  it("returns true when the server-injected meta says HMR is on", () => {
    withMetaContent("true", () => {
      expect(isHmrEnabled()).toBe(true);
    });
  });

  it("returns false when the meta tag is missing entirely", () => {
    // No injection → SPA must NOT open `/api/dev/events` (which
    // would 404 and EventSource-retry forever in a non-HMR build).
    withMetaContent(null, () => {
      expect(isHmrEnabled()).toBe(false);
    });
  });

  it("returns false for any meta content other than the literal `true`", () => {
    // Defensive: don't fail open on a malformed/legacy server that
    // injects an empty value or a placeholder.
    withMetaContent("", () => expect(isHmrEnabled()).toBe(false));
    withMetaContent("false", () => expect(isHmrEnabled()).toBe(false));
    withMetaContent("yes", () => expect(isHmrEnabled()).toBe(false));
  });

  it("returns false when there is no document at all (Node SSR / module-load probe)", () => {
    // The reader is called during component render; in any non-DOM
    // host (test fixtures that import the module without jsdom, a
    // hypothetical SSR pre-render) it must return false rather than
    // throwing on `document` being undefined.
    const had = "document" in globalThis;
    const previous = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      expect(isHmrEnabled()).toBe(false);
    } finally {
      if (had) (globalThis as { document?: unknown }).document = previous;
    }
  });
});
