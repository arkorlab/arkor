import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiClient, CloudApiError } from "./client";
import type { AnonymousCredentials } from "./credentials";
import type { ChatMessage } from "./types";
import {
  clearRecordedDeprecation,
  getRecordedDeprecation,
} from "./deprecation";

const anonCreds: AnonymousCredentials = {
  mode: "anon",
  token: "anon-tok",
  anonymousId: "abc",
  arkorCloudApiUrl: "http://mock",
  orgSlug: "anon-abc",
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function recorder(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const impl: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: CapturedCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

beforeEach(() => {
  // Reset the module-scoped deprecation latch to its production
  // baseline (`null`) so each test sees its own writes — and so a
  // leftover sentinel can't leak into other test files in the same
  // vitest worker.
  clearRecordedDeprecation();
});

afterEach(() => {
  clearRecordedDeprecation();
  vi.restoreAllMocks();
});

describe("CloudApiClient construction", () => {
  it("strips a trailing slash from baseUrl when building raw URLs", async () => {
    const { fetch: f, calls } = recorder(
      () => new Response(null, { status: 204 }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock/",
      credentials: anonCreds,
      fetch: f,
    });
    // Cancel goes through the typed RPC; openEventStream goes through raw
    // fetch and exposes the URL we want to assert on.
    await client
      .openEventStream("j1", { orgSlug: "o", projectSlug: "p" })
      .catch(() => {
        /* ignore stream open failure — we're only checking the URL */
      });
    // Single slash between origin and `/v1/...`, regardless of input form.
    expect(calls[0]?.url).toBe(
      "http://mock/v1/jobs/j1/events/stream?orgSlug=o&projectSlug=p",
    );
  });
});

describe("CloudApiClient.cancelJob", () => {
  it("resolves on 200 OK", async () => {
    const { fetch: f, calls } = recorder(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await client.cancelJob("j1", { orgSlug: "o", projectSlug: "p" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/jobs/j1/cancel");
    expect(calls[0]?.url).toContain("orgSlug=o");
    expect(calls[0]?.url).toContain("projectSlug=p");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer anon-tok");
  });

  it("throws CloudApiError with the parsed message on non-2xx", async () => {
    const { fetch: f } = recorder(
      () =>
        new Response(JSON.stringify({ error: "already cancelled" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await expect(
      client.cancelJob("j1", { orgSlug: "o", projectSlug: "p" }),
    ).rejects.toMatchObject({
      name: "CloudApiError",
      status: 409,
      message: "already cancelled",
    });
  });

  it("falls through to a generic message when the body is empty", async () => {
    // `||` (not `??`) in buildCloudApiError specifically handles this — an
    // empty body shouldn't produce an empty error message.
    const { fetch: f } = recorder(
      () => new Response("", { status: 500 }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const err = await client
      .cancelJob("j1", { orgSlug: "o", projectSlug: "p" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect((err as CloudApiError).status).toBe(500);
    expect((err as CloudApiError).message).toBe("cloud-api 500");
  });

  it("inlines the SDK upgrade hint on 426 (with structured body)", async () => {
    const { fetch: f } = recorder(
      () =>
        new Response(
          JSON.stringify({
            error: "sdk_version_unsupported",
            currentVersion: "1.3.5",
            supportedRange: "^1.4.0",
            upgrade: "npm install -g arkor@latest",
          }),
          {
            status: 426,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const err = await client
      .cancelJob("j1", { orgSlug: "o", projectSlug: "p" })
      .catch((e: unknown) => e);
    expect((err as CloudApiError).status).toBe(426);
    expect((err as CloudApiError).message).toContain(
      "1.3.5 is no longer supported",
    );
  });

  it("inlines the SDK upgrade hint on 426 even when body is non-JSON", async () => {
    // Mis-configured deployments may serve text/html for 426; the helper
    // promises a non-empty actionable message regardless.
    const { fetch: f } = recorder(
      () =>
        new Response("<html>upgrade required</html>", {
          status: 426,
          headers: { "content-type": "text/html" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const err = await client
      .cancelJob("j1", { orgSlug: "o", projectSlug: "p" })
      .catch((e: unknown) => e);
    expect((err as CloudApiError).status).toBe(426);
    expect((err as CloudApiError).message).toMatch(
      /Arkor SDK is no longer supported/,
    );
  });
});

describe("CloudApiClient.openEventStream", () => {
  it("forwards Last-Event-ID for resume when provided", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: ping\ndata: \n\n"));
        c.close();
      },
    });
    const { fetch: f, calls } = recorder(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const res = await client.openEventStream(
      "j-resume",
      { orgSlug: "o", projectSlug: "p" },
      { lastEventId: "1700000000-evt-42" },
    );
    expect(res.ok).toBe(true);
    expect(calls[0]?.headers.get("Last-Event-ID")).toBe("1700000000-evt-42");
    expect(calls[0]?.headers.get("Accept")).toBe("text/event-stream");
    expect(calls[0]?.headers.get("X-Arkor-Client")).toMatch(/^arkor\//);
  });

  it("does NOT send Last-Event-ID when no resume token is given", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(""));
        c.close();
      },
    });
    const { fetch: f, calls } = recorder(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await client.openEventStream("j-fresh", { orgSlug: "o", projectSlug: "p" });
    expect(calls[0]?.headers.has("Last-Event-ID")).toBe(false);
  });

  it("URL-encodes the jobId, orgSlug, and projectSlug", async () => {
    const { fetch: f, calls } = recorder(
      () => new Response("", { status: 500 }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    // Slashes / spaces / special chars must round-trip safely.
    await client
      .openEventStream("a/b c", {
        orgSlug: "o&x",
        projectSlug: "p?y",
      })
      .catch(() => undefined);
    const url = calls[0]?.url ?? "";
    expect(url).toContain("/v1/jobs/a%2Fb%20c/events/stream");
    expect(url).toContain("orgSlug=o%26x");
    expect(url).toContain("projectSlug=p%3Fy");
  });

  it("throws CloudApiError on non-2xx open and records deprecation if signalled", async () => {
    const { fetch: f } = recorder(
      () =>
        new Response("nope", {
          status: 503,
          headers: {
            Deprecation: "true",
            Warning: '299 - "Arkor SDK 1.4.0 is deprecated"',
          },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await expect(
      client.openEventStream("j1", { orgSlug: "o", projectSlug: "p" }),
    ).rejects.toMatchObject({ status: 503 });
    // tapDeprecation runs before the throw, so the latch should be set.
    expect(getRecordedDeprecation()?.message).toBe(
      "Arkor SDK 1.4.0 is deprecated",
    );
  });
});

describe("CloudApiClient.chat", () => {
  it("forwards the Authorization header and JSON body", async () => {
    const { fetch: f, calls } = recorder(
      () =>
        new Response("hi", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await client.chat({
      scope: { orgSlug: "o", projectSlug: "p" },
      body: {
        messages: [{ role: "user", content: "hi" }],
        adapter: { kind: "checkpoint", jobId: "j1", step: 5 },
        stream: false,
      },
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "http://mock/v1/inference/chat?orgSlug=o&projectSlug=p",
    );
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer anon-tok");
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    const parsed = JSON.parse(calls[0]?.body ?? "null") as {
      adapter: { jobId: string; step: number };
    };
    expect(parsed.adapter).toEqual({
      kind: "checkpoint",
      jobId: "j1",
      step: 5,
    });
  });

  it("propagates an AbortSignal so callers can cancel mid-stream", async () => {
    const ac = new AbortController();
    const { fetch: f, calls } = recorder((call) => {
      // The implementation passes signal through `fetchImpl(url, { signal })`
      // — verifying its presence on the captured init mirrors that contract.
      expect(call.method).toBe("POST");
      return new Response("ok", { status: 200 });
    });
    // Wrap our recorder to capture the init.signal too.
    const wrapped: typeof fetch = (async (input, init) => {
      expect(init?.signal).toBe(ac.signal);
      return f(input, init);
    }) as typeof fetch;
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: wrapped,
    });
    await client.chat({
      scope: { orgSlug: "o", projectSlug: "p" },
      body: { messages: [{ role: "user", content: "hi" }] },
      signal: ac.signal,
    });
    expect(calls).toHaveLength(1);
  });

  it("forwards tools / toolChoice / responseFormat / structuredOutputs verbatim through the JSON body", async () => {
    const { fetch: f, calls } = recorder(
      () => new Response("ok", { status: 200 }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: {
        name: "weather_reply",
        schema: { type: "object", properties: { tempC: { type: "number" } } },
        strict: true,
      },
    };
    const structuredOutputs = { regex: "^[A-Z]+$" };
    await client.chat({
      scope: { orgSlug: "o", projectSlug: "p" },
      body: {
        messages: [{ role: "user", content: "weather?" }],
        adapter: { kind: "checkpoint", jobId: "j1", step: 5 },
        tools,
        toolChoice: "auto",
        responseFormat,
        structuredOutputs,
      },
    });
    const parsed = JSON.parse(calls[0]?.body ?? "null") as Record<
      string,
      unknown
    >;
    // The SDK is a thin pass-through over JSON.stringify — every field on
    // `input.body` must appear under the same key on the wire so cloud-api
    // can route it to control-plane → vLLM.
    expect(parsed.tools).toEqual(tools);
    expect(parsed.toolChoice).toBe("auto");
    expect(parsed.responseFormat).toEqual(responseFormat);
    expect(parsed.structuredOutputs).toEqual(structuredOutputs);
  });

  it("accepts an assistant message with tool_calls but no content (common SDK persistence shape)", async () => {
    const { fetch: f, calls } = recorder(
      () => new Response("ok", { status: 200 }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    // Mirrors the OpenAI history shape: an assistant turn that's purely
    // a tool call, followed by the tool's response. The `ChatMessage[]`
    // annotation lets TS narrow each entry to the right discriminated
    // variant — in particular, the assistant entry's `tool_calls` has to
    // satisfy the non-empty-tuple `[ToolCall, ...ToolCall[]]` shape.
    const messages: ChatMessage[] = [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      {
        role: "tool",
        content: '{"tempC":21}',
        tool_call_id: "call_1",
      },
    ];
    await client.chat({
      scope: { orgSlug: "o", projectSlug: "p" },
      body: { messages, adapter: { kind: "final", jobId: "j2" } },
    });
    const parsed = JSON.parse(calls[0]?.body ?? "null") as {
      messages: unknown;
    };
    expect(parsed.messages).toEqual(messages);
  });

  it("throws CloudApiError on non-2xx with the upstream error message", async () => {
    const { fetch: f } = recorder(
      () =>
        new Response(JSON.stringify({ error: "bad adapter" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await expect(
      client.chat({
        scope: { orgSlug: "o", projectSlug: "p" },
        body: { messages: [] },
      }),
    ).rejects.toMatchObject({ status: 422, message: "bad adapter" });
  });
});

describe("CloudApiClient.listProjects", () => {
  it("hits /v1/projects?orgSlug=… and returns the parsed envelope", async () => {
    const { fetch: f, calls } = recorder(
      () =>
        new Response(
          JSON.stringify({
            org: { slug: "anon-abc", id: "o1", name: "Anon" },
            projects: [
              { id: "p1", slug: "play", name: "Play", orgId: "o1" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const { projects } = await client.listProjects("anon-abc");
    expect(projects[0]?.slug).toBe("play");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/v1/projects?orgSlug=anon-abc");
  });
});

describe("CloudApiClient.createProject", () => {
  it("POSTs the JSON body and returns the parsed envelope", async () => {
    const { fetch: f, calls } = recorder(
      () =>
        new Response(
          JSON.stringify({
            project: { id: "p1", slug: "new", name: "New", orgId: "o1" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const { project } = await client.createProject({
      orgSlug: "anon-abc",
      name: "New",
      slug: "new",
    });
    expect(project.id).toBe("p1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/projects?orgSlug=anon-abc");
    const body = JSON.parse(calls[0]?.body ?? "null") as Record<string, string>;
    expect(body).toEqual({ name: "New", slug: "new" });
  });
});

describe("CloudApiClient.getJob", () => {
  it("hits /v1/jobs/:id with the scope query and returns the parsed shape", async () => {
    const job = {
      id: "j7",
      orgId: "o1",
      projectId: "p1",
      name: "run",
      status: "running",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: "2026-01-01T00:00:01Z",
      completedAt: null,
    };
    const { fetch: f, calls } = recorder(
      () =>
        new Response(JSON.stringify({ job, events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const result = await client.getJob("j7", {
      orgSlug: "o",
      projectSlug: "p",
    });
    expect(result.job.id).toBe("j7");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/v1/jobs/j7");
    expect(calls[0]?.url).toContain("orgSlug=o");
    expect(calls[0]?.url).toContain("projectSlug=p");
  });

  it("propagates a CloudApiError on non-2xx", async () => {
    const { fetch: f } = recorder(
      () =>
        new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    await expect(
      client.getJob("missing", { orgSlug: "o", projectSlug: "p" }),
    ).rejects.toMatchObject({ status: 404, message: "not found" });
  });
});

describe("CloudApiClient.createJob", () => {
  it("POSTs name + config and returns the parsed envelope", async () => {
    const { fetch: f, calls } = recorder(
      () =>
        new Response(
          JSON.stringify({
            job: {
              id: "j-new",
              orgId: "o1",
              projectId: "p1",
              name: "run",
              status: "queued",
              config: {
                model: "m",
                datasetSource: { type: "huggingface", name: "x" },
              },
              createdAt: "2026-01-01T00:00:00Z",
              startedAt: null,
              completedAt: null,
            },
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: anonCreds,
      fetch: f,
    });
    const { job } = await client.createJob({
      orgSlug: "o",
      projectSlug: "p",
      name: "run",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
    });
    expect(job.id).toBe("j-new");
    expect(calls[0]?.url).toContain("/v1/jobs?");
    expect(calls[0]?.url).toContain("orgSlug=o");
    expect(calls[0]?.url).toContain("projectSlug=p");
    const body = JSON.parse(calls[0]?.body ?? "null") as {
      name: string;
      config: { model: string };
    };
    expect(body.name).toBe("run");
    expect(body.config.model).toBe("m");
  });
});

describe("CloudApiClient with auth0 credentials", () => {
  it("uses the access token in the Authorization header", async () => {
    // Branch coverage for `tokenFromCredentials`: the `accessToken` arm is
    // otherwise only used implicitly via the trainer tests (which run on
    // anon creds). Confirm the bearer string flips correctly.
    const { fetch: f, calls } = recorder(
      () => new Response(null, { status: 204 }),
    );
    const client = new CloudApiClient({
      baseUrl: "http://mock",
      credentials: {
        mode: "auth0",
        accessToken: "a0-access",
        refreshToken: "rt",
        expiresAt: 0,
        auth0Domain: "d",
        audience: "a",
        clientId: "c",
      },
      fetch: f,
    });
    await client
      .openEventStream("j", { orgSlug: "o", projectSlug: "p" })
      .catch(() => undefined);
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer a0-access");
  });
});

describe("CloudApiError", () => {
  it("carries the status and uses CloudApiError as the name", () => {
    const e = new CloudApiError(418, "I'm a teapot");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("CloudApiError");
    expect(e.status).toBe(418);
    expect(e.message).toBe("I'm a teapot");
  });
});
