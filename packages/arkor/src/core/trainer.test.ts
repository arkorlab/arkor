import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudApiError } from "./client";
import { createTrainer } from "./trainer";
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

  it("fails fast on anonymous-auth dead-end errors without retrying", async () => {
    // Anonymous-auth dead-ends (`anonymous_token_single_device`,
    // `anonymous_account_not_found`) never recover by reconnecting:
    // the server has already rejected this credentials' jti or
    // removed the underlying anonymous row. Burning the reconnect
    // budget here would just delay the inevitable failure and bury
    // the actionable recovery hint that `cli/main.ts` formats from
    // the same error. The fast-fail path bubbles the original
    // CloudApiError straight up so the top-level handler can format
    // it.
    await writeState(
      { orgSlug: "anon-org", projectSlug: "proj", projectId: "p1" },
      cwd,
    );
    const deadEnd = new CloudApiError(
      409,
      "Anonymous token is no longer current.",
      "anonymous_token_single_device",
    );
    const { fetch: fetcher, streamCalls } = streamFetcher([
      { kind: "throw", error: deadEnd },
      // Extra handlers in case of an unexpected retry; presence here
      // would make the assertion below clearly fail rather than
      // misleadingly pass on a "no more handlers" runtime error.
      { kind: "throw", error: deadEnd },
      { kind: "throw", error: deadEnd },
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
        maxReconnectAttempts: 5,
      },
    );

    const error = await withMockedFetch(fetcher, async () =>
      trainer.wait().catch((e: unknown) => e),
    );
    expect(error).toBe(deadEnd);
    // Exactly one open attempt: no retry burn.
    expect(streamCalls()).toBe(1);
  });

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
