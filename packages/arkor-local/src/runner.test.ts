import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROTOCOL_MARKER } from "./protocol";
import { JobStore, isTerminalStatus } from "./store";
import { RunManager } from "./runner";

import type { JobConfig } from "arkor";
import type { LocalTrainingBackend, TrainRunPaths } from "./backends/types";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/fake-trainer.mjs",
);

let rootDir: string;
let store: JobStore;
let manager: RunManager;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "arkor-local-runner-"));
  store = new JobStore({ rootDir });
  manager = new RunManager({ store, gracePeriodMs: 500 });
});

afterEach(async () => {
  await manager.closeAll();
  store.close();
  rmSync(rootDir, { recursive: true, force: true });
});

const CONFIG: JobConfig = {
  model: "m",
  datasetSource: { type: "huggingface", name: "x" },
};

/**
 * Backend whose "shim" is the fake-trainer fixture; the fixture block rides
 * inside run.json, so each test controls the child's behaviour.
 */
function fixtureBackend(
  fixture: Record<string, unknown>,
  opts?: {
    command?: string;
  },
): LocalTrainingBackend {
  return {
    id: "fake",
    displayName: "Fake backend",
    preflight: () => Promise.resolve({ ok: true }),
    validateConfig: () => ({ ok: true }),
    buildTrainRun: ({ paths }) => ({
      spec: {
        command: opts?.command ?? process.execPath,
        argv: [FIXTURE, "--run", paths.runJsonPath],
      },
      runJson: { fixture },
      warnings: [],
    }),
  };
}

async function launch(
  backend: LocalTrainingBackend,
): Promise<{ jobId: string; paths: TrainRunPaths }> {
  const record = await store.createJob({
    name: "run",
    config: CONFIG,
    backendId: backend.id,
  });
  const paths = store.paths(record.job.id, "/unused-shim-dir");
  await manager.startRun({
    jobId: record.job.id,
    config: CONFIG,
    backend,
    paths,
  });
  return { jobId: record.job.id, paths };
}

async function waitForTerminal(
  jobId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await store.getJob(jobId);
    if (record && isTerminalStatus(record.job.status)) return;
    if (Date.now() > deadline) throw new Error("job never became terminal");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function marker(payload: unknown): string {
  return `${PROTOCOL_MARKER}${JSON.stringify(payload)}\n`;
}

describe("RunManager happy path", () => {
  it("records the full event sequence and terminal status", async () => {
    const { jobId } = await launch(
      fixtureBackend({
        chunks: [
          marker({ type: "started" }),
          "loading tokenizer...\n",
          marker({ type: "log", step: 1, loss: 2.5 }),
          marker({ type: "checkpoint", step: 1, adapterDir: "/a/step-1" }),
          marker({ type: "completed", adapterDir: "/a/final" }),
        ],
      }),
    );
    await waitForTerminal(jobId);

    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("completed");
    expect(record?.job.startedAt).toBeTruthy();
    expect(record?.job.completedAt).toBeTruthy();
    expect(record?.pid).toBeNull();

    const events = await store.replayAfter(jobId, 0);
    expect(events.map((e) => e.event.type)).toEqual([
      "training.started",
      "training.log",
      "checkpoint.saved",
      "training.completed",
    ]);
    // The non-protocol line landed in console.log, not the event stream.
    const consoleLog = await readFile(store.consoleLogPath(jobId), "utf8");
    expect(consoleLog).toContain("loading tokenizer...");
  });

  it("reassembles protocol lines torn across chunks", async () => {
    const full = marker({ type: "log", step: 7, loss: 1.25 });
    const { jobId } = await launch(
      fixtureBackend({
        chunks: [
          marker({ type: "started" }),
          full.slice(0, 12),
          full.slice(12),
          marker({ type: "completed", adapterDir: "/a/final" }),
        ],
        chunkDelayMs: 30,
      }),
    );
    await waitForTerminal(jobId);
    const events = await store.replayAfter(jobId, 0);
    expect(events.map((e) => e.event.type)).toEqual([
      "training.started",
      "training.log",
      "training.completed",
    ]);
    expect(events[1]?.event).toMatchObject({ step: 7, loss: 1.25 });
  });

  it("logs malformed protocol lines and keeps going", async () => {
    const { jobId } = await launch(
      fixtureBackend({
        chunks: [
          marker({ type: "started" }),
          `${PROTOCOL_MARKER}{"type": "log", "step":\n`,
          `${PROTOCOL_MARKER}{"type": "not-a-real-event"}\n`,
          marker({ type: "completed", adapterDir: "/a/final" }),
        ],
      }),
    );
    await waitForTerminal(jobId);
    expect((await store.getJob(jobId))?.job.status).toBe("completed");
    const consoleLog = await readFile(store.consoleLogPath(jobId), "utf8");
    expect(consoleLog).toContain("skipped malformed protocol line");
  });
});

describe("RunManager failure paths", () => {
  it("fails the job when the child exits non-zero without a terminal event", async () => {
    const { jobId } = await launch(
      fixtureBackend({
        chunks: [marker({ type: "started" }), marker({ type: "log", step: 1 })],
        stderr: ["Traceback (most recent call last): boom"],
        exitCode: 1,
      }),
    );
    await waitForTerminal(jobId);
    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("failed");
    expect(record?.job.error).toContain("exited with code 1");
    expect(record?.job.error).toContain("console.log");
    const events = await store.replayAfter(jobId, 0);
    expect(events.at(-1)?.event.type).toBe("training.failed");
    const consoleLog = await readFile(store.consoleLogPath(jobId), "utf8");
    expect(consoleLog).toContain("Traceback");
  });

  it("treats exit 0 without `completed` as a protocol violation", async () => {
    const { jobId } = await launch(
      fixtureBackend({ chunks: [marker({ type: "started" })], exitCode: 0 }),
    );
    await waitForTerminal(jobId);
    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("failed");
    expect(record?.job.error).toContain("protocol violation");
  });

  it("honours the shim's own failed event over exit-code synthesis", async () => {
    const { jobId } = await launch(
      fixtureBackend({
        chunks: [
          marker({ type: "started" }),
          marker({
            type: "failed",
            error: "model not found on the Hub",
            step: 0,
          }),
        ],
        exitCode: 1,
      }),
    );
    await waitForTerminal(jobId);
    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("failed");
    expect(record?.job.error).toBe("model not found on the Hub");
    // Exactly one terminal event: the exit-code path must not append a
    // second training.failed after the shim's.
    const events = await store.replayAfter(jobId, 0);
    const terminals = events.filter((e) => e.event.type === "training.failed");
    expect(terminals).toHaveLength(1);
  });

  it("fails the job when the spawn itself fails", async () => {
    const { jobId } = await launch(
      fixtureBackend({}, { command: "arkor-definitely-not-a-binary" }),
    );
    await waitForTerminal(jobId);
    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("failed");
    expect(record?.job.error).toContain("failed to start trainer");
  });

  it("fails the job when buildTrainRun throws", async () => {
    const backend = fixtureBackend({});
    backend.buildTrainRun = () => {
      throw new Error("mapping exploded");
    };
    const { jobId } = await launch(backend);
    await waitForTerminal(jobId);
    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("failed");
    expect(record?.job.error).toContain("mapping exploded");
  });
});

describe("RunManager cancel", () => {
  it("terminates a hanging child and records a cancelled terminal", async () => {
    const { jobId } = await launch(
      fixtureBackend({ chunks: [marker({ type: "started" })], hang: true }),
    );
    // Give the child a moment to print `started`.
    await waitFor(async () => {
      const events = await store.replayAfter(jobId, 0);
      return events.some((e) => e.event.type === "training.started");
    });
    const hadChild = await manager.cancel(jobId);
    expect(hadChild).toBe(true);
    const record = await store.getJob(jobId);
    expect(record?.job.status).toBe("cancelled");
    expect(record?.job.error).toBe("Job cancelled");
    const events = await store.replayAfter(jobId, 0);
    expect(events.at(-1)?.event).toMatchObject({
      type: "training.failed",
      error: "Job cancelled",
    });
    expect(manager.liveCount).toBe(0);
  });

  it("returns false for jobs without a live child", async () => {
    await expect(manager.cancel("no-such-job")).resolves.toBe(false);
  });

  it("closeAll cancels every live child", async () => {
    const first = await launch(
      fixtureBackend({ chunks: [marker({ type: "started" })], hang: true }),
    );
    const second = await launch(
      fixtureBackend({ chunks: [marker({ type: "started" })], hang: true }),
    );
    await waitFor(() => Promise.resolve(manager.liveCount === 2));
    await manager.closeAll();
    expect(manager.liveCount).toBe(0);
    expect((await store.getJob(first.jobId))?.job.status).toBe("cancelled");
    expect((await store.getJob(second.jobId))?.job.status).toBe("cancelled");
  });
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
