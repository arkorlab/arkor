import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrainer } from "./trainer";
import {
  replaceTrainerCallbacks,
  requestTrainerEarlyStop,
} from "./trainerInspection";
import { writeState } from "./state";
import type { AnonymousCredentials } from "./credentials";

interface Expectation {
  method: string;
  path: string;
  status?: number;
  body: string | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function mockFetch(queue: Expectation[]): typeof fetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    const method = init?.method ?? "GET";
    if (next.method !== method || !url.includes(next.path)) {
      throw new Error(
        `expected ${next.method} …${next.path}, got ${method} ${url}`,
      );
    }
    const headers = new Headers({
      "content-type": "application/json",
      ...(next.headers ?? {}),
    });
    return new Response(next.body as BodyInit, {
      status: next.status ?? 200,
      headers,
    });
  }) as typeof fetch;
  (impl as unknown as { calls: typeof calls }).calls = calls;
  return impl;
}

let cwd: string;
const creds: AnonymousCredentials = {
  mode: "anon",
  token: "tok",
  anonymousId: "abcdefgh",
  arkorCloudApiUrl: "http://mock",
  orgSlug: "anon-org",
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "arkor-trainer-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("createTrainer (config builder branches)", () => {
  it("propagates every optional input field into the job config payload", async () => {
    // Branch coverage for the long `if (input.X !== undefined) config.X = ...`
    // chain in buildJobConfig. We can't observe the resulting config object
    // directly, but the trainer ships it as-is in the POST /v1/jobs body.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const minimalJobRow = {
      id: "j-cfg",
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
    };
    let postedConfig: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        const body = JSON.parse(init?.body as string) as {
          config: Record<string, unknown>;
        };
        postedConfig = body.config;
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-cfg/events/stream")) {
        return new Response(
          sseStream([
            `id: 1\nevent: training.completed\ndata: ${JSON.stringify({
              type: "training.completed",
              jobId: "j-cfg",
              timestamp: "2026-01-01T00:00:01Z",
            })}\n\n`,
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        lora: { r: 16, alpha: 32, maxLength: 2048, loadIn4bit: true },
        maxSteps: 100,
        numTrainEpochs: 1,
        learningRate: 0.0002,
        batchSize: 4,
        optim: "adamw_8bit",
        lrSchedulerType: "linear",
        weightDecay: 0.01,
        warmupSteps: 10,
        loggingSteps: 5,
        saveSteps: 50,
        evalSteps: 25,
        trainOnResponsesOnly: true,
        datasetFormat: "alpaca",
        datasetSplit: "train",
        dryRun: false,
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
      },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.wait();
    } finally {
      globalThis.fetch = original;
    }

    expect(postedConfig).toMatchObject({
      loraR: 16,
      loraAlpha: 32,
      maxLength: 2048,
      loadIn4bit: true,
      maxSteps: 100,
      numTrainEpochs: 1,
      learningRate: 0.0002,
      batchSize: 4,
      optim: "adamw_8bit",
      lrSchedulerType: "linear",
      weightDecay: 0.01,
      warmupSteps: 10,
      loggingSteps: 5,
      saveSteps: 50,
      evalSteps: 25,
      trainOnResponsesOnly: true,
      datasetFormat: "alpaca",
      datasetSplit: "train",
      dryRun: false,
    });
  });
});

describe("createTrainer (credentials defaulting)", () => {
  it("falls back to ensureCredentials() when context.credentials is omitted", async () => {
    // Branch coverage for `context.credentials ?? (await ensureCredentials())`
    // in both `getClient` and `resolveProjectState`. We pre-write
    // credentials so ensureCredentials() resolves without hitting fetch.
    const ORIG_HOME = process.env.HOME;
    // Node's `os.homedir()` reads HOME on POSIX but USERPROFILE (with a
    // HOMEDRIVE+HOMEPATH fallback) on Windows, so HOME alone doesn't
    // keep credential file IO inside the temp dir on Windows.
    const ORIG_USERPROFILE = process.env.USERPROFILE;
    const ORIG_HOMEDRIVE = process.env.HOMEDRIVE;
    const ORIG_HOMEPATH = process.env.HOMEPATH;
    const fakeHome = mkdtempSync(join(tmpdir(), "arkor-trainer-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.HOMEDRIVE = "";
    process.env.HOMEPATH = fakeHome;
    try {
      const credsMod = await import("./credentials");
      await credsMod.writeCredentials({
        mode: "anon",
        token: "tok",
        anonymousId: "abc",
        arkorCloudApiUrl: "http://mock",
        orgSlug: "anon-abc",
      });
      // Use a writable cwd so ensureProjectState writes state.json there.
      const localCwd = mkdtempSync(join(tmpdir(), "arkor-trainer-cwd-"));
      try {
        await writeState(
          { orgSlug: "anon-abc", projectSlug: "proj", projectId: "p1" },
          localCwd,
        );

        const minimalJobRow = {
          id: "j-default-creds",
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
        };
        const sse = [
          `id: 1\nevent: training.completed\ndata: ${JSON.stringify({
            type: "training.completed",
            jobId: "j-default-creds",
            timestamp: "2026-01-01T00:00:01Z",
          })}\n\n`,
        ];
        const fetcher = mockFetch([
          {
            method: "POST",
            path: "/v1/jobs?",
            body: JSON.stringify({ job: minimalJobRow }),
            status: 201,
          },
          {
            method: "GET",
            path: "/v1/jobs/j-default-creds/events/stream",
            body: sseStream(sse),
            headers: { "content-type": "text/event-stream" },
          },
        ]);

        const trainer = createTrainer(
          {
            name: "run",
            model: "m",
            dataset: { type: "huggingface", name: "x" },
          },
          // Note: NO `credentials` here — trainer must call ensureCredentials.
          {
            baseUrl: "http://mock",
            cwd: localCwd,
            reconnectDelayMs: 1,
          },
        );
        const original = globalThis.fetch;
        globalThis.fetch = fetcher;
        try {
          await expect(trainer.wait()).resolves.toMatchObject({
            job: { status: "completed" },
          });
        } finally {
          globalThis.fetch = original;
        }
      } finally {
        rmSync(localCwd, { recursive: true, force: true });
      }
    } finally {
      if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
      else delete process.env.HOME;
      if (ORIG_USERPROFILE !== undefined)
        process.env.USERPROFILE = ORIG_USERPROFILE;
      else delete process.env.USERPROFILE;
      if (ORIG_HOMEDRIVE !== undefined)
        process.env.HOMEDRIVE = ORIG_HOMEDRIVE;
      else delete process.env.HOMEDRIVE;
      if (ORIG_HOMEPATH !== undefined) process.env.HOMEPATH = ORIG_HOMEPATH;
      else delete process.env.HOMEPATH;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("createTrainer (SSE event stream)", () => {
  it("dispatches onStarted, onLog, onCheckpoint, onCompleted in order", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const jobRow = {
      id: "j1",
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
    };
    const sse = [
      `id: 2026-01-01T00:00:01Z\nevent: training.started\ndata: ${JSON.stringify(
        { type: "training.started", jobId: "j1", timestamp: "2026-01-01T00:00:01Z" },
      )}\n\n`,
      `id: 2026-01-01T00:00:02Z\nevent: training.log\ndata: ${JSON.stringify(
        {
          type: "training.log",
          jobId: "j1",
          timestamp: "2026-01-01T00:00:02Z",
          step: 1,
          loss: 1.23,
        },
      )}\n\n`,
      `id: 2026-01-01T00:00:03Z\nevent: checkpoint.saved\ndata: ${JSON.stringify(
        {
          type: "checkpoint.saved",
          jobId: "j1",
          timestamp: "2026-01-01T00:00:03Z",
          step: 10,
        },
      )}\n\n`,
      `id: 2026-01-01T00:00:04Z\nevent: training.completed\ndata: ${JSON.stringify(
        {
          type: "training.completed",
          jobId: "j1",
          timestamp: "2026-01-01T00:00:04Z",
          artifacts: [{ pathname: "adapter.json" }],
        },
      )}\n\n`,
    ];

    const fetcher = mockFetch([
      { method: "POST", path: "/v1/jobs?", body: JSON.stringify({ job: jobRow }), status: 201 },
      {
        method: "GET",
        path: "/v1/jobs/j1/events/stream",
        body: sseStream(sse),
        headers: { "content-type": "text/event-stream" },
      },
    ]);

    const calls: string[] = [];
    let inferBoundStep: number | null = null;
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onStarted: ({ job }) => void calls.push(`onStarted(${job.status})`),
          onLog: ({ step, loss }) => void calls.push(`onLog(${step},${loss})`),
          onCheckpoint: ({ step, adapter }) => {
            inferBoundStep = adapter.step;
            calls.push(`onCheckpoint(${step})`);
          },
          onCompleted: ({ artifacts }) =>
            void calls.push(`onCompleted(${artifacts.length})`),
          onFailed: () => void calls.push("onFailed"),
        },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 5,
      },
    );
    // Inject mock fetch by rebinding the client's fetch via a fresh
    // CloudApiClient constructed with our fetcher. We do that by monkey-
    // patching globalThis.fetch since the trainer builds its own client
    // through ensureCredentials → CloudApiClient({ fetch: undefined }).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await trainer.wait();
      expect(result.job.status).toBe("completed");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      "onStarted(running)",
      "onLog(1,1.23)",
      "onCheckpoint(10)",
      "onCompleted(1)",
    ]);
    expect(inferBoundStep).toBe(10);
  });

  it("dispatches onFailed on training.failed", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const jobRow = {
      id: "j2",
      orgId: "o1",
      projectId: "p1",
      name: "run",
      status: "queued",
      config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
    const sse = [
      `id: 1\nevent: training.failed\ndata: ${JSON.stringify(
        {
          type: "training.failed",
          jobId: "j2",
          timestamp: "2026-01-01T00:00:01Z",
          error: "CUDA OOM",
        },
      )}\n\n`,
    ];
    const fetcher = mockFetch([
      { method: "POST", path: "/v1/jobs?", body: JSON.stringify({ job: jobRow }), status: 201 },
      {
        method: "GET",
        path: "/v1/jobs/j2/events/stream",
        body: sseStream(sse),
        headers: { "content-type": "text/event-stream" },
      },
    ]);

    let captured: string | null = null;
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onFailed: ({ error }) => {
            captured = error;
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 5 },
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await trainer.wait();
      expect(result.job.status).toBe("failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(captured).toBe("CUDA OOM");
  });

  it("binds infer() to the checkpoint adapter and proxies to /v1/inference/chat", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const jobRow = {
      id: "j3",
      orgId: "o1",
      projectId: "p1",
      name: "run",
      status: "queued",
      config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
    const sse = [
      `id: 1\nevent: checkpoint.saved\ndata: ${JSON.stringify(
        {
          type: "checkpoint.saved",
          jobId: "j3",
          timestamp: "2026-01-01T00:00:01Z",
          step: 5,
        },
      )}\n\n`,
      `id: 2\nevent: training.completed\ndata: ${JSON.stringify(
        {
          type: "training.completed",
          jobId: "j3",
          timestamp: "2026-01-01T00:00:02Z",
        },
      )}\n\n`,
    ];

    // Extra expectation: the infer() call made inside onCheckpoint.
    const fetcher = mockFetch([
      {
        method: "POST",
        path: "/v1/jobs?",
        body: JSON.stringify({ job: jobRow }),
        status: 201,
      },
      {
        method: "GET",
        path: "/v1/jobs/j3/events/stream",
        body: sseStream(sse),
        headers: { "content-type": "text/event-stream" },
      },
      {
        method: "POST",
        path: "/v1/inference/chat",
        body: "hello from checkpoint 5",
        headers: { "content-type": "text/plain" },
      },
    ]);

    let inferResponseText: string | null = null;
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onCheckpoint: async ({ infer }) => {
            const res = await infer({
              messages: [{ role: "user", content: "hi" }],
              stream: false,
            });
            inferResponseText = await res.text();
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 5 },
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.wait();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(inferResponseText).toBe("hello from checkpoint 5");
  });

  it("forwards infer({ tools, toolChoice, responseFormat, structuredOutputs }) verbatim through to /v1/inference/chat", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const jobRow = {
      id: "j7",
      orgId: "o1",
      projectId: "p1",
      name: "run",
      status: "queued",
      config: { model: "m", datasetSource: { type: "huggingface", name: "x" } },
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
    };
    const sse = [
      `id: 1\nevent: checkpoint.saved\ndata: ${JSON.stringify({
        type: "checkpoint.saved",
        jobId: "j7",
        timestamp: "2026-01-01T00:00:01Z",
        step: 7,
      })}\n\n`,
      `id: 2\nevent: training.completed\ndata: ${JSON.stringify({
        type: "training.completed",
        jobId: "j7",
        timestamp: "2026-01-01T00:00:02Z",
      })}\n\n`,
    ];
    const fetcher = mockFetch([
      {
        method: "POST",
        path: "/v1/jobs?",
        body: JSON.stringify({ job: jobRow }),
        status: 201,
      },
      {
        method: "GET",
        path: "/v1/jobs/j7/events/stream",
        body: sseStream(sse),
        headers: { "content-type": "text/event-stream" },
      },
      {
        method: "POST",
        path: "/v1/inference/chat",
        body: "ack",
        headers: { "content-type": "text/plain" },
      },
    ]);
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ];
    const responseFormat = { type: "json_object" as const };
    const structuredOutputs = { regex: "^OK$" };
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onCheckpoint: async ({ infer }) => {
            await infer({
              messages: [{ role: "user", content: "hi" }],
              tools,
              toolChoice: { type: "function", function: { name: "search" } },
              responseFormat,
              structuredOutputs,
              stream: false,
            });
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 5 },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.wait();
    } finally {
      globalThis.fetch = originalFetch;
    }
    const calls = (fetcher as unknown as {
      calls: Array<{ url: string; init?: RequestInit }>;
    }).calls;
    const chatCall = calls.find((c) => c.url.includes("/v1/inference/chat"));
    expect(chatCall).toBeDefined();
    const body = JSON.parse(chatCall!.init?.body as string) as Record<
      string,
      unknown
    >;
    // The trainer's infer() helper is the path users plug their tool /
    // structured-output knobs into during a run — pin that nothing gets
    // dropped before reaching cloud-api.
    expect(body.tools).toEqual(tools);
    expect(body.toolChoice).toEqual({
      type: "function",
      function: { name: "search" },
    });
    expect(body.responseFormat).toEqual(responseFormat);
    expect(body.structuredOutputs).toEqual(structuredOutputs);
    expect(body.adapter).toEqual({ kind: "checkpoint", jobId: "j7", step: 7 });
  });
});

// Regression for ENG-406 — the previous reconnect loop had no upper bound
// and no jitter, so a permanently-down cloud-api would keep retrying every
// `reconnectDelayMs` forever (and on recovery several SDK clients would
// reconnect at exactly the same instant).
describe("createTrainer (reconnect backoff + max attempts)", () => {
  const minimalJobRow = {
    id: "j1",
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
  };

  function streamFetcher(
    handlers: Array<
      | { kind: "throw"; error: Error }
      | { kind: "stream"; chunks: string[] }
    >,
  ): { fetch: typeof fetch; streamCalls: () => number } {
    let streamCalls = 0;
    const impl: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j1/events/stream")) {
        const handler = handlers[streamCalls++];
        if (!handler) {
          throw new Error(`unexpected stream open #${streamCalls}`);
        }
        if (handler.kind === "throw") throw handler.error;
        return new Response(sseStream(handler.chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;
    return { fetch: impl, streamCalls: () => streamCalls };
  }

  async function withMockedFetch<T>(
    impl: typeof fetch,
    body: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await body();
    } finally {
      globalThis.fetch = original;
    }
  }

  it("rejects after maxReconnectAttempts of consecutive open failures", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // max=2 → 1 initial + 2 retries before giving up on the 3rd attempt.
    const { fetch: fetcher, streamCalls } = streamFetcher([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
    ]);

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 5,
        maxReconnectAttempts: 2,
      },
    );

    const error = await withMockedFetch(fetcher, async () =>
      trainer.wait().catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /failed 3 consecutive times/,
    );
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(streamCalls()).toBe(3);
  });

  it("resets the failure counter after the stream yields any frame", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // Without the reset, max=2 would trip after [throw, success, throw, throw]
    // (4 opens). With the reset, the success in slot 2 wipes the previous
    // failure, so we get [throw, success, throw, throw, throw] = 5 opens
    // before the 3rd consecutive failure exceeds the limit.
    const { fetch: fetcher, streamCalls } = streamFetcher([
      { kind: "throw", error: new TypeError("fetch failed") },
      {
        kind: "stream",
        chunks: [
          `id: 1\nevent: training.log\ndata: ${JSON.stringify({
            type: "training.log",
            jobId: "j1",
            timestamp: "2026-01-01T00:00:01Z",
            step: 1,
            loss: 1,
          })}\n\n`,
          // No terminal event — stream closes cleanly, outer loop reconnects.
        ],
      },
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
    ]);

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 5,
        maxReconnectAttempts: 2,
      },
    );

    await withMockedFetch(fetcher, async () => {
      await expect(trainer.wait()).rejects.toThrow(
        /failed 3 consecutive times/,
      );
    });
    expect(streamCalls()).toBe(5);
  });

  // Codex review on PR #13 (round 2) flagged that jitter is applied
  // *after* the exponential is clamped to `maxReconnectDelayMs`, so a
  // saturated `exp` could still wait up to 1.25 × the documented cap
  // when `Math.random()` lands near 1.
  // Codex review on PR #13 (round 3) flagged that a 200-OK stream that
  // EOFs without emitting any frame would loop forever at the base delay
  // — `maxReconnectAttempts` was bypassed because clean closes never
  // touched the failure counter. Misconfigured proxies / load-balancers
  // that accept the connection and immediately drop it would hang
  // `wait()` indefinitely.
  it("counts clean closes with no frames toward maxReconnectAttempts", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // 200 OK with empty body each time (proxy accepts then EOFs). With
    // max=2, three empty streams should exhaust the budget.
    const { fetch: fetcher, streamCalls } = streamFetcher([
      { kind: "stream", chunks: [] },
      { kind: "stream", chunks: [] },
      { kind: "stream", chunks: [] },
    ]);

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 5,
        maxReconnectAttempts: 2,
      },
    );

    const error = await withMockedFetch(fetcher, async () =>
      trainer.wait().catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/failed 3 consecutive times/);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toMatch(
      /closed without emitting any frame/,
    );
    expect(streamCalls()).toBe(3);
  });

  it("clamps the jittered delay at maxReconnectDelayMs", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // Math.random = 0.9 → jitter component = exp * (0.9 * 0.5 - 0.25) =
    // exp * 0.20. Without the outer clamp, exp + jitter = 1.20 × cap.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.9);
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn, ms) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn as () => void, 0);
      });

    try {
      const { fetch: fetcher } = streamFetcher([
        { kind: "throw", error: new TypeError("fetch failed") },
        { kind: "throw", error: new TypeError("fetch failed") },
      ]);

      const trainer = createTrainer(
        {
          name: "run",
          model: "m",
          dataset: { type: "huggingface", name: "x" },
        },
        {
          baseUrl: "http://mock",
          credentials: creds,
          cwd,
          // base = cap means `exp` saturates the cap on the very first
          // attempt, so the jitter would push above without the clamp.
          reconnectDelayMs: 100,
          maxReconnectDelayMs: 100,
          maxReconnectAttempts: 1,
        },
      );

      await withMockedFetch(fetcher, async () => {
        await expect(trainer.wait()).rejects.toThrow();
      });

      // Single backoff between the first failure and the second attempt
      // (the second hits maxReconnectAttempts and throws without delay).
      // Was 120 ms before the fix; must not exceed 100.
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBeLessThanOrEqual(100);
    } finally {
      setTimeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it("trainer.cancel() POSTs /v1/jobs/:id/cancel after the job has started", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const minimalJobRow = {
      id: "j-cancel",
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
    };
    // The trainer fires `POST /v1/jobs` synchronously inside the start()
    // path, so cancel() needs the job row to be assigned. We never open the
    // event stream — cancel() should not depend on it.
    const sse = [
      `id: 1\nevent: training.completed\ndata: ${JSON.stringify({
        type: "training.completed",
        jobId: "j-cancel",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
    ];
    let cancelCallSeen = false;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-cancel/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (
        method === "POST" &&
        url.includes("/v1/jobs/j-cancel/cancel")
      ) {
        cancelCallSeen = true;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
      },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      // Start the run by awaiting wait() — the streamed completion event
      // closes the loop quickly so cancel() runs against a fully-resolved
      // startedJob/scope pair.
      await trainer.wait();
      await trainer.cancel();
      expect(cancelCallSeen).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats `event: end` as a terminal frame and stops the loop", async () => {
    // Branch coverage for the `event: end` early-exit. cloud-api sends
    // this when the SSE channel is shutting down cleanly without a
    // training.completed event (e.g. session timeout); the trainer must
    // treat it as terminal so wait() resolves rather than reconnecting.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const minimalJobRow = {
      id: "j-end",
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
    };
    const sse = ["id: 1\nevent: end\ndata: \n\n"];
    const fetcher = mockFetch([
      {
        method: "POST",
        path: "/v1/jobs?",
        body: JSON.stringify({ job: minimalJobRow }),
        status: 201,
      },
      {
        method: "GET",
        path: "/v1/jobs/j-end/events/stream",
        body: sseStream(sse),
        headers: { "content-type": "text/event-stream" },
      },
    ]);
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
      },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await expect(trainer.wait()).resolves.toMatchObject({
        job: { id: "j-end" },
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("skips malformed event payloads without aborting the stream", async () => {
    // Branch coverage for the `try/catch` around JSON.parse — a single
    // malformed `data:` line shouldn't tear down the whole training run.
    // Send one garbage frame followed by a real terminal event.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const minimalJobRow = {
      id: "j-bad",
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
    };
    const sse = [
      `id: 1\nevent: training.log\ndata: not-json {{{\n\n`,
      `id: 2\nevent: training.completed\ndata: ${JSON.stringify({
        type: "training.completed",
        jobId: "j-bad",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
    ];
    const fetcher = mockFetch([
      {
        method: "POST",
        path: "/v1/jobs?",
        body: JSON.stringify({ job: minimalJobRow }),
        status: 201,
      },
      {
        method: "GET",
        path: "/v1/jobs/j-bad/events/stream",
        body: sseStream(sse),
        headers: { "content-type": "text/event-stream" },
      },
    ]);
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
      },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await trainer.wait();
      expect(result.job.status).toBe("completed");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("recovers when the SSE body itself errors mid-stream", async () => {
    // Branch coverage for the catch around the for-await iterator —
    // covers the case where the stream's underlying body emits an error
    // (e.g. a network disconnect partway through). The reconnect loop
    // should treat it as a failure, count it toward the limit, then
    // recover on a fresh stream.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const minimalJobRow = {
      id: "j1",
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
    };
    let streamCount = 0;
    const enc = new TextEncoder();
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j1/events/stream")) {
        streamCount++;
        if (streamCount === 1) {
          // First stream errors mid-flight after one frame.
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                enc.encode(
                  `id: 1\nevent: training.log\ndata: ${JSON.stringify({
                    type: "training.log",
                    jobId: "j1",
                    timestamp: "2026-01-01T00:00:01Z",
                    step: 1,
                    loss: 1,
                  })}\n\n`,
                ),
              );
              c.error(new Error("connection reset by peer"));
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        // Second stream completes cleanly.
        return new Response(
          sseStream([
            `id: 2\nevent: training.completed\ndata: ${JSON.stringify({
              type: "training.completed",
              jobId: "j1",
              timestamp: "2026-01-01T00:00:02Z",
            })}\n\n`,
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
        maxReconnectAttempts: 3,
      },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await trainer.wait();
      expect(result.job.status).toBe("completed");
    } finally {
      globalThis.fetch = original;
    }
    expect(streamCount).toBe(2);
  });

  it("trainer.cancel() is a no-op before the job has been created", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // No fetch mock at all — if cancel() reached the API we'd see a real
    // network error. Safety net for callers that wire up cancel() to
    // SIGINT before kicking off the run.
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      { baseUrl: "http://mock", credentials: creds, cwd },
    );
    await expect(trainer.cancel()).resolves.toBeUndefined();
  });

  it("propagates AbortSignal aborts mid-reconnect-delay (cancels the timer)", async () => {
    // Branch coverage for the `onAbort` clearTimeout path inside the
    // reconnect delay. Long base delay + an abortSignal that aborts after
    // the first failure → wait() must reject quickly, not after 60s.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const minimalJobRow = {
      id: "j-abort",
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
    };
    let streamCount = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        method === "GET" &&
        url.includes("/v1/jobs/j-abort/events/stream")
      ) {
        streamCount++;
        // Always fail so the trainer enters its delay loop.
        throw new TypeError("fetch failed");
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const ac = new AbortController();
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        abortSignal: ac.signal,
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        // Big base delay so the delay loop is still pending when we abort.
        reconnectDelayMs: 60_000,
        maxReconnectDelayMs: 60_000,
        maxReconnectAttempts: 5,
      },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    // Abort shortly after the first stream-open fails so the helper is
    // currently inside its setTimeout-based delay.
    setTimeout(() => ac.abort(new Error("user pressed Ctrl-C")), 30);
    try {
      const start = Date.now();
      await expect(trainer.wait()).rejects.toThrow();
      const elapsed = Date.now() - start;
      // Aborted long before the 60 s retry budget would have allowed.
      expect(elapsed).toBeLessThan(5_000);
      expect(streamCount).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("emits backoff delays that grow exponentially (no jitter, ×2 each attempt)", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // Math.random = 0.5 → jitter component is exactly zero, so the delay
    // schedule is base * 2^attempt clamped to maxReconnectDelayMs.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn, ms) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn as () => void, 0);
      });

    try {
      const { fetch: fetcher } = streamFetcher([
        { kind: "throw", error: new TypeError("fetch failed") },
        { kind: "throw", error: new TypeError("fetch failed") },
        { kind: "throw", error: new TypeError("fetch failed") },
      ]);

      const trainer = createTrainer(
        {
          name: "run",
          model: "m",
          dataset: { type: "huggingface", name: "x" },
        },
        {
          baseUrl: "http://mock",
          credentials: creds,
          cwd,
          reconnectDelayMs: 10,
          maxReconnectDelayMs: 1_000_000,
          maxReconnectAttempts: 2,
        },
      );

      await withMockedFetch(fetcher, async () => {
        await expect(trainer.wait()).rejects.toThrow();
      });

      // Two backoff delays before the third attempt errors out (the third
      // open hits maxReconnectAttempts and throws without delaying).
      expect(delays).toEqual([10, 20]);
    } finally {
      setTimeoutSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });
});

describe("createTrainer (early stop)", () => {
  const minimalJobRow = {
    id: "j-stop",
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
  };

  it("calls cancel after the next checkpoint when early-stop is requested mid-run", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // SSE stream: training.started → training.log → checkpoint.saved.
    // The checkpoint event is the trigger for the early-stop branch in
    // dispatch(); after that, the loop should treat the run as terminal
    // (we asserted this by ending the wait() promise without sending
    // training.completed).
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 0.5,
      })}\n\n`,
      `id: 3\nevent: checkpoint.saved\ndata: ${JSON.stringify({
        type: "checkpoint.saved",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        step: 10,
      })}\n\n`,
    ];

    let cancelCalls = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          // Arm the early-stop latch from inside the on-log callback so it
          // fires before the checkpoint dispatch — mirrors the real CLI
          // path where SIGTERM arrives mid-run. Fire-and-forget so the
          // dispatch loop isn't blocked waiting for the latch's own
          // checkpoint trigger to arrive.
          onLog: () => {
            void requestTrainerEarlyStop(trainer, { timeoutMs: 60_000 });
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    let result: Awaited<ReturnType<typeof trainer.wait>>;
    try {
      result = await trainer.wait();
    } finally {
      globalThis.fetch = original;
    }
    expect(cancelCalls).toBe(1);
    // Regression: the early-stop checkpoint branch returns
    // `{ terminal: true }` to break out of `wait()`'s loop without
    // waiting for a cloud-side terminal event. The `TrainingResult`
    // it resolves with must therefore reflect a terminal status
    // locally — otherwise `wait()` violates its documented contract
    // ("Resolve when the job reaches a terminal status") and a
    // subsequent `requestEarlyStop` wouldn't see the
    // `TERMINAL_STATUSES` short-circuit.
    expect(result.job.status).toBe("cancelled");
    expect(result.job.completedAt).toBe("2026-01-01T00:00:03Z");
  });

  it("early-stop checkpoint branch returns the checkpoint's artifacts in wait()'s result", async () => {
    // Regression: the early-stop terminal return used
    // `terminalResult?.artifacts ?? []`, but `wait()` always calls
    // `dispatch(parsed, null)` so `terminalResult` was forever
    // null → `wait()` resolved with `artifacts: []` even though
    // the checkpoint event carries the very artefacts the
    // early-stop existed to *preserve* (the whole point of the
    // graceful-stop-at-next-checkpoint pattern is to keep that
    // work). Now we return `event.artifacts` directly so the
    // checkpoint's outputs make it into the resolved result.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const checkpointArtifacts = [
      { kind: "lora_adapter" as const, path: "/checkpoints/step-10/" },
      { kind: "metric" as const, name: "loss", value: 0.42 },
    ];
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 0.5,
      })}\n\n`,
      `id: 3\nevent: checkpoint.saved\ndata: ${JSON.stringify({
        type: "checkpoint.saved",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        step: 10,
        artifacts: checkpointArtifacts,
      })}\n\n`,
    ];
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onLog: () => {
            void requestTrainerEarlyStop(trainer, { timeoutMs: 60_000 });
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    let result: Awaited<ReturnType<typeof trainer.wait>>;
    try {
      result = await trainer.wait();
    } finally {
      globalThis.fetch = original;
    }
    // The artefacts the checkpoint event carried must travel
    // through to the wait() result — that's the whole point of
    // graceful-stop-at-next-checkpoint preserving the in-flight
    // work.
    expect(result.artifacts).toEqual(checkpointArtifacts);
    // Sibling assertion: status is still terminal (covered more
    // thoroughly in the dedicated test above; this one just
    // ensures we didn't accidentally regress the status while
    // changing the artefacts return).
    expect(result.job.status).toBe("cancelled");
  });

  it("early-stop branch still settles when the user's onCheckpoint callback throws (no SIGTERM hang)", async () => {
    // Regression: the early-stop branch ran AFTER
    // `await callbacks.onCheckpoint?.(ctx)`. A user-callback throw
    // would propagate out of that await before the early-stop
    // cancel + latch settlement could run, leaving
    // `earlyStopDeferred` pending. The runner's
    // `installShutdownHandlers` awaits that deferred → SIGTERM
    // shutdown hangs until the (default 5-min) timeout fallback
    // fires. The fix wraps `onCheckpoint` in try/catch, runs the
    // early-stop branch unconditionally, then re-throws the
    // captured callback error so wait()'s reconnect loop keeps
    // its prior semantics.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 0.5,
      })}\n\n`,
      `id: 3\nevent: checkpoint.saved\ndata: ${JSON.stringify({
        type: "checkpoint.saved",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        step: 10,
      })}\n\n`,
    ];
    let cancelCalls = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    let armedPromise: Promise<void> | null = null;
    let armedResult: "resolved" | "rejected" | "pending" = "pending";
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onLog: () => {
            if (armedPromise === null) {
              armedPromise = requestTrainerEarlyStop(trainer, {
                timeoutMs: 60_000,
              });
              armedPromise.then(
                () => {
                  armedResult = "resolved";
                },
                () => {
                  armedResult = "rejected";
                },
              );
            }
          },
          onCheckpoint: () => {
            // User callback throws DURING the checkpoint that
            // would normally trigger early-stop. Without the
            // try/catch wrap this throw would skip the
            // early-stop branch → latch pending → SIGTERM hang
            // for up to 60s (our `timeoutMs`).
            throw new Error("user onCheckpoint boom");
          },
        },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
        // Cap reconnects at 0 so the user-callback throw
        // surfaces as a wait() rejection instead of
        // looping forever (handleFailure would otherwise
        // reconnect after the throw escapes dispatch).
        maxReconnectAttempts: 0,
      },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      // wait() rejects — handleFailure wraps the user callback
      // throw because maxReconnectAttempts is 0.
      await expect(trainer.wait()).rejects.toThrow();
      // Critical: the latch SETTLED via the early-stop branch
      // (resolve), not via the 60-second timeout. The cancel POST
      // also fired (early-stop reached the cancel call before the
      // throw was re-raised). Together: shutdown wouldn't hang.
      await new Promise((r) => setImmediate(r));
      expect(armedResult).toBe("resolved");
      expect(cancelCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("early-stop checkpoint branch rejects the deferred when cancel() throws (visible to shutdown handler)", async () => {
    // Regression: previously, an `await trainer.cancel()` that threw
    // (network failure / cloud-api 5xx during the cancel POST) was
    // *swallowed*, the deferred resolved cleanly, and the runner
    // exited 0 — the UI declared the run cancelled while the cloud
    // job kept running, orphaning GPU spend with no visible error.
    // The fix REJECTS the deferred so the runner's
    // `installShutdownHandlers` `.catch()` writes the failure to
    // stderr, surfacing the issue to the operator. The latch is
    // still always settled (resolved or rejected), so shutdown
    // doesn't hang waiting for a checkpoint that will never come.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 0.5,
      })}\n\n`,
      `id: 3\nevent: checkpoint.saved\ndata: ${JSON.stringify({
        type: "checkpoint.saved",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        step: 10,
      })}\n\n`,
    ];
    let cancelAttempts = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelAttempts += 1;
        // Simulate the cloud-api being unreachable mid-cancel.
        throw new TypeError("fetch failed");
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    // Capture the very-first armed early-stop promise so we can
    // assert its settlement state below. The trainer is mutually
    // recursive with the callback (`onLog` calls
    // `requestTrainerEarlyStop(trainer, ...)`), so we declare it
    // first as `let` and assign in a second step.
    let armedPromise: Promise<void> | null = null;
    let armedResult: "resolved" | "rejected" | "pending" = "pending";
    let armedError: unknown = null;
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onLog: () => {
            // Arm exactly once and capture the returned promise.
            // requestTrainerEarlyStop is idempotent across repeat
            // calls, but we only need the FIRST armed deferred —
            // the cancel-throw rejects exactly that promise.
            if (armedPromise === null) {
              armedPromise = requestTrainerEarlyStop(trainer, {
                timeoutMs: 60_000,
              });
              armedPromise.then(
                () => {
                  armedResult = "resolved";
                },
                (err: unknown) => {
                  armedResult = "rejected";
                  armedError = err;
                },
              );
            }
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.wait();
      // Flush microtasks so the .then(resolve, reject) handler
      // observes the settlement before we assert.
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.fetch = original;
    }
    // cancel() was attempted (and threw).
    expect(cancelAttempts).toBe(1);
    // The armed deferred REJECTED — the runner's `.catch()` would
    // see this error and log it to stderr instead of silently
    // exiting 0. Critically: it didn't hang on "pending"; the
    // failure case still settles, just via reject not resolve.
    expect(armedResult).toBe("rejected");
    expect(armedError).toBeInstanceOf(TypeError);
    expect((armedError as Error).message).toBe("fetch failed");
  });

  it("resolves the early-stop latch when the run hits a terminal event before the next checkpoint", async () => {
    // Regression: previously `requestEarlyStop()`'s deferred was
    // only resolved by (a) the checkpoint-triggered cancel branch
    // or (b) the timeout fallback. If the run reached
    // `training.completed` / `training.failed` *before* another
    // checkpoint landed (a common case for short jobs or runs that
    // had already saved their last checkpoint when SIGTERM arrived),
    // the deferred stayed pending until the (default 5-min) timeout
    // fired — the SIGTERM handler in `installShutdownHandlers`
    // awaits that promise before exit, so shutdown was delayed up to
    // `timeoutMs`. Both terminal branches now settle the latch
    // explicitly so the signal path completes immediately when the
    // job is already terminal.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // started → log (arms early-stop) → completed; no checkpoint.saved
    // in between, so the checkpoint-triggered resolution path is *not*
    // exercised — only the new terminal-branch settlement is.
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 0.5,
      })}\n\n`,
      `id: 3\nevent: training.completed\ndata: ${JSON.stringify({
        type: "training.completed",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        artifacts: [],
      })}\n\n`,
    ];

    let cancelCalls = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    let stopResolved = false;
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onLog: () => {
            // Long timeout: if the fix regresses, this test would
            // hang for ~60s before the timer fires. With the
            // terminal-branch settlement, the deferred resolves the
            // moment `training.completed` lands.
            void requestTrainerEarlyStop(trainer, {
              timeoutMs: 60_000,
            }).then(() => {
              stopResolved = true;
            });
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await trainer.wait();
      // Flush microtasks so the .then() chain off `requestEarlyStop`
      // observes the resolution before we assert.
      await new Promise((r) => setImmediate(r));
      expect(result.job.status).toBe("completed");
      // No cancel POST was issued — the terminal branch just
      // releases the latch; it doesn't cancel a run that already
      // completed on its own.
      expect(cancelCalls).toBe(0);
      // The latch resolved via the terminal handler, not via the
      // 60-second timeout. (The test would simply time out long
      // before the timeout fired if this regressed.)
      expect(stopResolved).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("settles the early-stop latch even when the user's onCompleted callback throws", async () => {
    // Regression: previously `settleEarlyStopLatch()` was called
    // *after* awaiting `callbacks.onCompleted` / `onFailed`. A
    // thrown user callback propagated out of `dispatch()` before
    // the settle ran, leaving `earlyStopDeferred` pending — the
    // SIGTERM handler in `installShutdownHandlers` would block on
    // that promise until the (default 5-min) timeout fired,
    // delaying shutdown for a user-code bug. Wrapping in
    // `try/finally` ensures the latch is released regardless,
    // while preserving the throw's propagation through `wait()` so
    // callers still see the original error.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 0.5,
      })}\n\n`,
      `id: 3\nevent: training.completed\ndata: ${JSON.stringify({
        type: "training.completed",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        artifacts: [],
      })}\n\n`,
    ];

    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    let stopResolved = false;
    let stopRejected = false;
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onLog: () => {
            // Arm early-stop with a long timeout — if the latch
            // isn't released by `finally`, this would hang for the
            // full 60 seconds.
            void requestTrainerEarlyStop(trainer, {
              timeoutMs: 60_000,
            }).then(
              () => {
                stopResolved = true;
              },
              () => {
                stopRejected = true;
              },
            );
          },
          onCompleted: () => {
            throw new Error("user callback boom");
          },
        },
      },
      {
        baseUrl: "http://mock",
        credentials: creds,
        cwd,
        reconnectDelayMs: 1,
        // `wait()` catches dispatch throws and routes them through
        // its reconnect loop; with the default unbounded retry the
        // user-callback throw above would loop forever and the test
        // would just time out. Cap retries at 0 so the first thrown
        // dispatch surfaces as a `wait()` rejection — that lets us
        // observe the *latch* settlement (the actual contract under
        // test) cleanly.
        maxReconnectAttempts: 0,
      },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      // The user-callback throw is wrapped by `handleFailure` after
      // `maxReconnectAttempts: 0` exhausts; the original error is
      // preserved as `cause`. We just need wait() to settle so the
      // test doesn't hang — the *body* of the assertion is the
      // latch state below.
      await expect(trainer.wait()).rejects.toThrow();
      // The latch must have settled (via `finally`) BEFORE wait()
      // rejected. Without the `try/finally` around `onCompleted`
      // the latch would still be armed → `stopResolved` stays
      // false → the test fails (rather than timing out, since
      // `maxReconnectAttempts: 0` already unblocks wait()).
      await new Promise((r) => setImmediate(r));
      expect(stopResolved).toBe(true);
      expect(stopRejected).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("falls back to immediate cancel when no checkpoint arrives within timeoutMs", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    // No checkpoint in the stream — only training.completed, which would
    // normally finish the run. We hand-roll a stream that never ends so
    // the timeout fallback is what actually triggers cancel.
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const stallingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode(
            `id: 1\nevent: training.started\ndata: ${JSON.stringify({
              type: "training.started",
              jobId: "j-stop",
              timestamp: "2026-01-01T00:00:01Z",
            })}\n\n`,
          ),
        );
      },
    });

    let cancelCalls = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(stallingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        // Closing the stream now mimics cloud-api's response to a cancel:
        // the SSE channel ends and wait() exits its loop.
        streamController?.close();
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.start();
      // Tiny timeout so the test doesn't actually wait 5 minutes.
      await requestTrainerEarlyStop(trainer, { timeoutMs: 5 });
      expect(cancelCalls).toBe(1);
      // Regression: the timeout fallback used to leave
      // `earlyStopRequested = true` and `startedJob.status =
      // "running"`. A subsequent `requestEarlyStop()` call would
      // then re-arm a fresh timer and re-issue cancel even though
      // the early-stop already fired. With the latch reset and
      // local terminal-status update mirroring the
      // checkpoint-triggered branch, the second call hits the
      // TERMINAL_STATUSES short-circuit and is a true no-op.
      await requestTrainerEarlyStop(trainer, { timeoutMs: 5 });
      expect(cancelCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("timeout fallback rejects the deferred when cancel() throws (visible to shutdown handler)", async () => {
    // Companion to the checkpoint-branch reject test: when no
    // checkpoint arrives within `timeoutMs`, the timeout fallback
    // does its own `trainer.cancel()`. Old code swallowed cancel
    // errors and ALWAYS resolved the deferred — same false-success
    // failure mode as the checkpoint branch had: local runner
    // exits cleanly while the cloud job keeps consuming GPU
    // budget. The fix mirrors the checkpoint reject path: capture
    // the error and reject the deferred so the runner's
    // `.catch()` writes it to stderr.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const stallingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode(
            `id: 1\nevent: training.started\ndata: ${JSON.stringify({
              type: "training.started",
              jobId: "j-stop",
              timestamp: "2026-01-01T00:00:01Z",
            })}\n\n`,
          ),
        );
      },
    });

    let cancelCalls = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(stallingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        // Close the stream so wait() exits its loop even though we
        // throw on the cancel POST itself.
        streamController?.close();
        // Simulate cloud-api unreachable mid-cancel (transport).
        throw new TypeError("fetch failed");
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.start();
      // Tiny timeout so the timeout fallback fires fast (no
      // checkpoint will land — stream only carries
      // training.started). The returned promise should REJECT
      // because the cancel POST throws.
      await expect(
        requestTrainerEarlyStop(trainer, { timeoutMs: 5 }),
      ).rejects.toThrow(/fetch failed/);
      expect(cancelCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("is a no-op before start() and resolves immediately", async () => {
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    // Should resolve without contacting cloud-api at all.
    await requestTrainerEarlyStop(trainer, { timeoutMs: 1 });
  });

  it("waits out an in-flight start() so a SIGTERM during create-job can still cancel the new job", async () => {
    // Codex P1 regression: `start()` sets `scope` *before* awaiting
    // `client.createJob`, so there's a real window where the cloud
    // job is being created but `startedJob` is still null. If a
    // runner-side SIGTERM lands in that window, an immediate
    // "no-op" early-stop would let `installShutdownHandlers` exit
    // the process — leaving the just-created cloud job running
    // with no cancel POST. The fix is to await the in-flight
    // `start()` promise inside `requestEarlyStop()` so the cancel
    // path sees a definite job id (or a definite start failure).
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    let cancelCalls = 0;
    let releaseCreateJob!: () => void;
    const createJobReleased = new Promise<void>((resolve) => {
      releaseCreateJob = resolve;
    });
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        // Hold createJob open so we can fire `requestEarlyStop`
        // mid-flight. Once the test releases the gate, return a
        // valid job — that establishes the post-create state
        // requestEarlyStop should then act on (cancel POST).
        await createJobReleased;
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );

    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      // Fire start() but DON'T await — its createJob is gated.
      const startPromise = trainer.start();
      // Yield once so the start microtasks queue up to the
      // `await client.createJob`.
      await new Promise((r) => setImmediate(r));
      // requestEarlyStop fires while start() is mid-flight. With
      // the fix it awaits start() rather than no-op'ing immediately.
      // Tiny `timeoutMs` so once `start()` resolves the latch's
      // timeout-fallback fires the cancel POST quickly — there's no
      // SSE stream in this test, so the checkpoint-driven path
      // never arrives. We're testing the "stop awaited start()" leg
      // of the contract, not the checkpoint plumbing.
      const stopPromise = requestTrainerEarlyStop(trainer, {
        timeoutMs: 50,
      });
      // Sanity: stop hasn't resolved yet — it's blocked on
      // start() which is blocked on createJob.
      let stopSettled = false;
      void stopPromise.then(() => {
        stopSettled = true;
      });
      await new Promise((r) => setImmediate(r));
      expect(stopSettled).toBe(false);
      // Release createJob → start() resolves → stop() proceeds.
      releaseCreateJob();
      await startPromise;
      await stopPromise;
      // The deciding behaviour: cancel POST was issued because the
      // stop awaited start() and saw a real job id. Without the
      // in-flight gate, stop would have returned immediately on
      // the null `startedJob`, no cancel POST, cloud job orphaned.
      expect(cancelCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("replaceTrainerCallbacks (internal HMR brand) swaps the dispatched callbacks on the next event", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const sse = [
      `id: 1\nevent: training.started\ndata: ${JSON.stringify({
        type: "training.started",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:01Z",
      })}\n\n`,
      `id: 2\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:02Z",
        step: 1,
        loss: 1,
      })}\n\n`,
      `id: 3\nevent: training.log\ndata: ${JSON.stringify({
        type: "training.log",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:03Z",
        step: 2,
        loss: 0.5,
      })}\n\n`,
      `id: 4\nevent: training.completed\ndata: ${JSON.stringify({
        type: "training.completed",
        jobId: "j-stop",
        timestamp: "2026-01-01T00:00:04Z",
      })}\n\n`,
    ];
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/v1/jobs/j-stop/events/stream")) {
        return new Response(sseStream(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const calls: string[] = [];
    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
        callbacks: {
          onLog: ({ step }) => {
            calls.push(`v1:onLog(${step})`);
            // After the first onLog call, swap to v2 callbacks via the
            // internal `Symbol.for("arkor.trainer.replaceCallbacks")`
            // brand — the same brand `arkor dev`'s SIGUSR2 handler
            // uses. The next event must dispatch via the new object.
            if (step === 1) {
              replaceTrainerCallbacks(trainer, {
                onLog: ({ step: s }) => void calls.push(`v2:onLog(${s})`),
              });
            }
          },
        },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.wait();
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual(["v1:onLog(1)", "v2:onLog(2)"]);
  });

  it("is idempotent — repeated calls share the same in-flight promise", async () => {
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    let cancelCalls = 0;
    const fetcher: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/v1/jobs?")) {
        return new Response(JSON.stringify({ job: minimalJobRow }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.includes("/v1/jobs/j-stop/cancel")) {
        cancelCalls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const trainer = createTrainer(
      {
        name: "run",
        model: "m",
        dataset: { type: "huggingface", name: "x" },
      },
      { baseUrl: "http://mock", credentials: creds, cwd, reconnectDelayMs: 1 },
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await trainer.start();
      const a = requestTrainerEarlyStop(trainer, { timeoutMs: 5 });
      const b = requestTrainerEarlyStop(trainer, { timeoutMs: 5 });
      await Promise.all([a, b]);
      // The fallback timer fires once, so cancel is called once even though
      // the early-stop brand was invoked twice.
      expect(cancelCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
