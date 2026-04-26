import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
