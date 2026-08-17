import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROTOCOL_MARKER } from "./protocol";
import { buildLocalApp } from "./server";
import { JobStore, isTerminalStatus } from "./store";
import { RunManager } from "./runner";

import type { Hono } from "hono";
import type { ChatProxy } from "./server";
import type { LocalTrainingBackend } from "./backends/types";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/fake-trainer.mjs",
);

const TOKEN = "test-local-token-0123456789abcdef";

let rootDir: string;
let store: JobStore;
let manager: RunManager;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "arkor-local-server-"));
  store = new JobStore({ rootDir });
  manager = new RunManager({ store, gracePeriodMs: 500 });
});

afterEach(async () => {
  await manager.closeAll();
  store.close();
  rmSync(rootDir, { recursive: true, force: true });
});

function marker(payload: unknown): string {
  return `${PROTOCOL_MARKER}${JSON.stringify(payload)}\n`;
}

function fixtureBackend(
  fixtureOverride?: Record<string, unknown>,
  overrides: Partial<LocalTrainingBackend> = {},
): LocalTrainingBackend {
  const fixture = fixtureOverride ?? {
    chunks: [
      marker({ type: "started" }),
      marker({ type: "log", step: 1, loss: 2 }),
      marker({ type: "completed", adapterDir: "/a/final" }),
    ],
  };
  return {
    id: "fake",
    displayName: "Fake backend",
    preflight: () => Promise.resolve({ ok: true }),
    validateConfig: () => ({ ok: true }),
    buildTrainRun: ({ paths }) => ({
      spec: {
        command: process.execPath,
        argv: [FIXTURE, "--run", paths.runJsonPath],
      },
      runJson: { fixture },
      warnings: [],
    }),
    inference: {
      buildServerSpec: () => ({ command: process.execPath, argv: [] }),
    },
    ...overrides,
  };
}

function makeApp(
  backend: LocalTrainingBackend = fixtureBackend(),
  chatProxy?: ChatProxy,
): Hono {
  return buildLocalApp({
    token: TOKEN,
    store,
    runManager: manager,
    backend,
    shimDir: "/unused-shim-dir",
    chatProxy,
  });
}

function authed(
  init: Omit<RequestInit, "headers"> & {
    headers?: Record<string, string>;
  } = {},
): RequestInit {
  return {
    ...init,
    headers: {
      host: "127.0.0.1:1234",
      authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  };
}

const JOB_BODY = JSON.stringify({
  name: "run",
  config: {
    model: "mlx-community/tiny",
    datasetSource: { type: "huggingface", name: "org/data" },
    maxSteps: 10,
  },
});

async function createJobAndWait(app: Hono): Promise<string> {
  const res = await app.request(
    "/v1/jobs",
    authed({ method: "POST", body: JOB_BODY }),
  );
  expect(res.status).toBe(201);
  const { job } = (await res.json()) as { job: { id: string } };
  const deadline = Date.now() + 15_000;
  for (;;) {
    const record = await store.getJob(job.id);
    if (record && isTerminalStatus(record.job.status)) return job.id;
    if (Date.now() > deadline) throw new Error("job never became terminal");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("auth boundary", () => {
  it("rejects non-loopback hosts", async () => {
    const app = makeApp();
    const res = await app.request("/v1/jobs", {
      headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a missing or malformed bearer token", async () => {
    const app = makeApp();
    const equalLengthWrong = `${TOKEN.slice(0, -1)}X`;
    const cases: Record<string, string>[] = [
      { host: "127.0.0.1" },
      { host: "127.0.0.1", authorization: "Bearer wrong-token-abcdef123456" },
      // Same length as the real token: exercises the timingSafeEqual body,
      // not just the length short-circuit.
      { host: "127.0.0.1", authorization: `Bearer ${equalLengthWrong}` },
      { host: "127.0.0.1", authorization: TOKEN },
    ];
    for (const headers of cases) {
      const res = await app.request("/v1/jobs", { headers });
      expect(res.status).toBe(401);
    }
  });

  it("accepts localhost as well as 127.0.0.1", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/jobs",
      authed({ headers: { host: "localhost:9999" } }),
    );
    expect(res.status).toBe(200);
  });

  it("refuses to build with a weak token", () => {
    expect(() =>
      buildLocalApp({
        token: "short",
        store,
        runManager: manager,
        backend: fixtureBackend(),
        shimDir: "/unused",
      }),
    ).toThrow(/16 characters/);
  });
});

describe("job routes", () => {
  it("creates, lists, and fetches a job (scope params ignored)", async () => {
    const app = makeApp();
    const jobId = await createJobAndWait(app);

    const list = await app.request(
      "/v1/jobs?orgSlug=whatever&projectSlug=ignored",
      authed(),
    );
    expect(list.status).toBe(200);
    const { jobs } = (await list.json()) as { jobs: { id: string }[] };
    expect(jobs.map((j) => j.id)).toContain(jobId);

    const get = await app.request(`/v1/jobs/${jobId}`, authed());
    expect(get.status).toBe(200);
    const { job } = (await get.json()) as { job: { status: string } };
    expect(job.status).toBe("completed");

    const missing = await app.request("/v1/jobs/nope", authed());
    expect(missing.status).toBe(404);
  });

  it("rejects an invalid envelope with 400", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/jobs",
      authed({ method: "POST", body: JSON.stringify({ name: "x" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("surfaces backend config rejections as a single 400 with per-field lines", async () => {
    const backend = fixtureBackend(undefined, {
      validateConfig: () => ({
        ok: false,
        errors: ["maxSteps or numTrainEpochs is required", "optim is bad"],
      }),
    });
    const app = makeApp(backend);
    const res = await app.request(
      "/v1/jobs",
      authed({ method: "POST", body: JOB_BODY }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("maxSteps or numTrainEpochs is required");
    expect(error).toContain("optim is bad");
  });
});

describe("cancel route", () => {
  it("cancels a hanging job and is idempotent on terminal jobs", async () => {
    const app = makeApp(
      fixtureBackend({ chunks: [marker({ type: "started" })], hang: true }),
    );
    const created = await app.request(
      "/v1/jobs",
      authed({ method: "POST", body: JOB_BODY }),
    );
    const { job } = (await created.json()) as { job: { id: string } };

    // Wait until the child registered.
    const deadline = Date.now() + 15_000;
    while (manager.liveCount === 0) {
      if (Date.now() > deadline) throw new Error("child never spawned");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const cancel = await app.request(
      `/v1/jobs/${job.id}/cancel`,
      authed({ method: "POST" }),
    );
    expect(cancel.status).toBe(200);
    const cancelled = (await cancel.json()) as { job: { status: string } };
    expect(cancelled.job.status).toBe("cancelled");

    const again = await app.request(
      `/v1/jobs/${job.id}/cancel`,
      authed({ method: "POST" }),
    );
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { job: { status: string } }).job.status,
    ).toBe("cancelled");
  });

  it("cancels a queued job that has no live child", async () => {
    const app = makeApp();
    const record = await store.createJob({
      name: "queued-only",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    const res = await app.request(
      `/v1/jobs/${record.job.id}/cancel`,
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect((await store.getJob(record.job.id))?.job.status).toBe("cancelled");
    const events = await store.replayAfter(record.job.id, 0);
    expect(events.at(-1)?.event.type).toBe("training.failed");
  });
});

describe("event stream", () => {
  it("replays history with ids, honours Last-Event-ID, and ends terminal jobs", async () => {
    const app = makeApp();
    const jobId = await createJobAndWait(app);

    const full = await app.request(`/v1/jobs/${jobId}/events/stream`, authed());
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toContain("text/event-stream");
    const fullText = await full.text();
    expect(fullText).toContain("id: 1\nevent: training.started");
    expect(fullText).toContain("event: training.log");
    expect(fullText).toContain("event: training.completed");
    expect(fullText).toContain("event: end");

    const resumed = await app.request(
      `/v1/jobs/${jobId}/events/stream`,
      authed({ headers: { "last-event-id": "2" } }),
    );
    const resumedText = await resumed.text();
    expect(resumedText).not.toContain("event: training.started");
    expect(resumedText).not.toContain("event: training.log");
    expect(resumedText).toContain("event: training.completed");
    expect(resumedText).toContain("event: end");
  });

  it("404s for unknown jobs", async () => {
    const app = makeApp();
    const res = await app.request("/v1/jobs/nope/events/stream", authed());
    expect(res.status).toBe(404);
  });

  it("streams live events after replay, in order and without duplicates", async () => {
    const app = makeApp();
    const record = await store.createJob({
      name: "live",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    const jobId = record.job.id;
    const logEvent = (step: number) =>
      ({
        type: "training.log",
        jobId,
        timestamp: "2026-01-01T00:00:00Z",
        step,
        loss: 1,
        evalLoss: null,
        learningRate: null,
        epoch: null,
        samplesPerSecond: null,
      }) as const;
    await store.appendEvent(jobId, logEvent(1));
    await store.appendEvent(jobId, logEvent(2));

    const res = await app.request(
      `/v1/jobs/${jobId}/events/stream`,
      authed({ headers: { "last-event-id": "1" } }),
    );
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream body");
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 10_000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(`never received ${needle}; got: ${received}`);
        }
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    };
    // Replay: seq 2 only (Last-Event-ID: 1).
    await readUntil("id: 2\n");
    expect(received).not.toContain("id: 1\n");

    // Live append lands on the open stream.
    await store.appendEvent(jobId, logEvent(3));
    await readUntil("id: 3\n");

    // Terminal append + end notification close the stream in order.
    await store.appendEvent(jobId, {
      type: "training.completed",
      jobId,
      timestamp: "2026-01-01T00:00:01Z",
      artifacts: [],
    });
    await store.updateJob(jobId, (r) => {
      r.job.status = "completed";
    });
    store.notifyEnded(jobId);
    await readUntil("event: end");
    // Ordered ids, no duplicates.
    const ids = [...received.matchAll(/^id: (\d+)$/gm)].map((m) =>
      Number(m[1]),
    );
    expect(ids).toEqual([2, 3, 4]);
    expect(received.indexOf("training.completed")).toBeLessThan(
      received.indexOf("event: end"),
    );
  });
});

describe("chat route", () => {
  const CHAT_BODY = {
    messages: [{ role: "user", content: "hi" }],
    baseModel: "mlx-community/tiny",
  };

  function captureProxy(): {
    proxy: ChatProxy;
    calls: { model: string; adapterPath: string | null }[];
  } {
    const calls: { model: string; adapterPath: string | null }[] = [];
    return {
      calls,
      proxy: {
        handleChat: ({ model, adapterPath }) => {
          calls.push({ model, adapterPath });
          return Promise.resolve(Response.json({ ok: true }));
        },
        closeAll: () => Promise.resolve(),
      },
    };
  }

  it("503s when no chat proxy is wired", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/inference/chat",
      authed({ method: "POST", body: JSON.stringify(CHAT_BODY) }),
    );
    expect(res.status).toBe(503);
  });

  it("501s when the backend has no inference support", async () => {
    const backend = fixtureBackend();
    delete backend.inference;
    const { proxy } = captureProxy();
    const app = makeApp(backend, proxy);
    const res = await app.request(
      "/v1/inference/chat",
      authed({ method: "POST", body: JSON.stringify(CHAT_BODY) }),
    );
    expect(res.status).toBe(501);
  });

  it("requires adapter or baseModel", async () => {
    const { proxy } = captureProxy();
    const app = makeApp(fixtureBackend(), proxy);
    const res = await app.request(
      "/v1/inference/chat",
      authed({
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("adapter");
    expect(error).toContain("baseModel");
  });

  it("rejects unsupported chat features explicitly", async () => {
    const { proxy } = captureProxy();
    const app = makeApp(fixtureBackend(), proxy);
    for (const feature of [
      "tools",
      "toolChoice",
      "responseFormat",
      "structuredOutputs",
    ]) {
      const res = await app.request(
        "/v1/inference/chat",
        authed({
          method: "POST",
          body: JSON.stringify({ ...CHAT_BODY, [feature]: {} }),
        }),
      );
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain(feature);
      expect(error).toContain("not supported in local mode");
    }
  });

  it("routes baseModel chats to the proxy", async () => {
    const { proxy, calls } = captureProxy();
    const app = makeApp(fixtureBackend(), proxy);
    const res = await app.request(
      "/v1/inference/chat",
      authed({ method: "POST", body: JSON.stringify(CHAT_BODY) }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ model: "mlx-community/tiny", adapterPath: null }]);
  });

  it("resolves adapter jobs to their normalised adapter directory", async () => {
    const { proxy, calls } = captureProxy();
    const app = makeApp(fixtureBackend(), proxy);
    const record = await store.createJob({
      name: "trained",
      config: {
        model: "mlx-community/tiny",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    const adapters = join(store.jobDir(record.job.id), "adapters");
    await mkdir(join(adapters, "final"), { recursive: true });
    await writeFile(join(adapters, "final", "adapter_config.json"), "{}");
    await mkdir(join(adapters, "step-5"), { recursive: true });
    await writeFile(join(adapters, "step-5", "adapter_config.json"), "{}");

    // Unknown job: 404 with the job id in the message.
    const unknown = await app.request(
      "/v1/inference/chat",
      authed({
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          adapter: { jobId: "nope" },
        }),
      }),
    );
    expect(unknown.status).toBe(404);

    // Step-addressed request resolves the step directory.
    const step = await app.request(
      "/v1/inference/chat",
      authed({
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          adapter: { jobId: record.job.id, step: 5 },
        }),
      }),
    );
    expect(step.status).toBe(200);
    // A step with no published directory is a clean 404, NOT a silent
    // fallback to final/: serving different weights than the requested
    // step would corrupt checkpoint comparisons.
    const missingStep = await app.request(
      "/v1/inference/chat",
      authed({
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          adapter: { jobId: record.job.id, step: 999 },
        }),
      }),
    );
    expect(missingStep.status).toBe(404);
    // No step: resolves the final adapter.
    const finalRes = await app.request(
      "/v1/inference/chat",
      authed({
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          adapter: { jobId: record.job.id },
        }),
      }),
    );
    expect(finalRes.status).toBe(200);
    expect(calls).toEqual([
      { model: "mlx-community/tiny", adapterPath: join(adapters, "step-5") },
      { model: "mlx-community/tiny", adapterPath: join(adapters, "final") },
    ]);

    // A job with no adapters yet: 404 with a helpful message.
    const bare = await store.createJob({
      name: "no-adapters",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    const none = await app.request(
      "/v1/inference/chat",
      authed({
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          adapter: { jobId: bare.job.id },
        }),
      }),
    );
    expect(none.status).toBe(404);
    const { error } = (await none.json()) as { error: string };
    expect(error).toContain("no adapter");
  });
});

describe("identity stub", () => {
  it("serves a static local identity", async () => {
    const app = makeApp();
    const res = await app.request("/v1/me", authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: "local", email: null },
      orgs: [{ id: "local", slug: "local", name: "Local" }],
    });
  });
});
