import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JobStore } from "./store";

import type { LocalStreamEvent } from "./protocol";
import type { StoredEvent } from "./store";

let rootDir: string;
let store: JobStore;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "arkor-local-store-"));
  store = new JobStore({ rootDir });
});

afterEach(() => {
  store.close();
  rmSync(rootDir, { recursive: true, force: true });
});

function logEvent(jobId: string, step: number): LocalStreamEvent {
  return {
    type: "training.log",
    jobId,
    timestamp: "2026-01-01T00:00:00Z",
    step,
    loss: 1,
    evalLoss: null,
    learningRate: null,
    epoch: null,
    samplesPerSecond: null,
  };
}

async function createJob(name = "run"): Promise<string> {
  const record = await store.createJob({
    name,
    config: {
      model: "m",
      datasetSource: { type: "huggingface", name: "x" },
    },
    backendId: "fake",
  });
  return record.job.id;
}

describe("JobStore jobs", () => {
  it("creates a queued job with the local org/project scope", async () => {
    const id = await createJob();
    const record = await store.getJob(id);
    expect(record).toMatchObject({
      job: {
        id,
        orgId: "local",
        projectId: "local",
        status: "queued",
        error: null,
      },
      pid: null,
      backendId: "fake",
    });
  });

  it("lists jobs newest first and skips unreadable entries", async () => {
    const first = await createJob("first");
    // createdAt has millisecond resolution; force distinct timestamps.
    await store.updateJob(first, (r) => {
      r.job.createdAt = "2026-01-01T00:00:00.000Z";
    });
    const second = await createJob("second");
    await store.updateJob(second, (r) => {
      r.job.createdAt = "2026-01-02T00:00:00.000Z";
    });
    await appendFile(join(rootDir, "jobs", "not-a-job"), "garbage");
    const jobs = await store.listJobs();
    expect(jobs.map((j) => j.name)).toEqual(["second", "first"]);
  });

  it("returns null for unknown jobs", async () => {
    await expect(store.getJob("nope")).resolves.toBeNull();
  });
});

describe("JobStore events", () => {
  it("appends with monotonically increasing seq and replays after a cursor", async () => {
    const id = await createJob();
    const seqs = [
      await store.appendEvent(id, logEvent(id, 1)),
      await store.appendEvent(id, logEvent(id, 2)),
      await store.appendEvent(id, logEvent(id, 3)),
    ];
    expect(seqs).toEqual([1, 2, 3]);
    const replayed = await store.replayAfter(id, 1);
    expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
    expect(replayed[0]?.event).toMatchObject({ type: "training.log", step: 2 });
  });

  it("keeps seq monotonic across store instances (restart survival)", async () => {
    const id = await createJob();
    await store.appendEvent(id, logEvent(id, 1));
    await store.appendEvent(id, logEvent(id, 2));

    const reopened = new JobStore({ rootDir });
    const seq = await reopened.appendEvent(id, logEvent(id, 3));
    expect(seq).toBe(3);
    const replayed = await reopened.replayAfter(id, 0);
    expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
    reopened.close();
  });

  it("assigns unique seqs to concurrent appends", async () => {
    const id = await createJob();
    const seqs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.appendEvent(id, logEvent(id, i)),
      ),
    );
    expect(new Set(seqs).size).toBe(10);
    expect(Math.max(...seqs)).toBe(10);
  });

  it("tolerates a torn final line from a crash mid-append", async () => {
    const id = await createJob();
    await store.appendEvent(id, logEvent(id, 1));
    await appendFile(
      join(rootDir, "jobs", id, "events.jsonl"),
      '{"seq":2,"event":{"type":"training.l',
    );
    const replayed = await store.replayAfter(id, 0);
    expect(replayed.map((e) => e.seq)).toEqual([1]);
  });

  it("fans out appended events and end notifications to subscribers", async () => {
    const id = await createJob();
    const seen: StoredEvent[] = [];
    let ended = false;
    const unsubscribe = store.subscribe(id, {
      onEvent: (e) => seen.push(e),
      onEnd: () => {
        ended = true;
      },
    });
    await store.appendEvent(id, logEvent(id, 1));
    store.notifyEnded(id);
    expect(seen.map((e) => e.seq)).toEqual([1]);
    expect(ended).toBe(true);
    unsubscribe();
    await store.appendEvent(id, logEvent(id, 2));
    expect(seen).toHaveLength(1);
  });
});

describe("JobStore console log", () => {
  it("caps console output with an explicit truncation notice", async () => {
    const capped = new JobStore({ rootDir, consoleByteCap: 32 });
    const id = (
      await capped.createJob({
        name: "run",
        config: {
          model: "m",
          datasetSource: { type: "huggingface", name: "x" },
        },
        backendId: "fake",
      })
    ).job.id;
    capped.appendConsole(id, "a".repeat(30) + "\n");
    capped.appendConsole(id, "b".repeat(30) + "\n");
    capped.appendConsole(id, "never-written\n");
    capped.close();
    // Wait for the write stream to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const content = await readFile(capped.consoleLogPath(id), "utf8");
    expect(content).toContain("a".repeat(30));
    expect(content).toContain("truncated");
    expect(content).not.toContain("never-written");
  });
});

describe("JobStore.reconcileOrphans", () => {
  it("fails running jobs whose pid is gone and leaves live pids alone", async () => {
    const deadPid = await spawnAndReapPid();
    const orphaned = await createJob("orphaned");
    await store.updateJob(orphaned, (r) => {
      r.job.status = "running";
      r.pid = deadPid;
    });
    const alive = await createJob("alive");
    await store.updateJob(alive, (r) => {
      r.job.status = "running";
      r.pid = process.pid;
    });
    const finished = await createJob("finished");
    await store.updateJob(finished, (r) => {
      r.job.status = "completed";
    });

    await store.reconcileOrphans();

    const orphanedRecord = await store.getJob(orphaned);
    expect(orphanedRecord?.job.status).toBe("failed");
    expect(orphanedRecord?.job.error).toContain("interrupted");
    const orphanEvents = await store.replayAfter(orphaned, 0);
    expect(orphanEvents.at(-1)?.event.type).toBe("training.failed");

    expect((await store.getJob(alive))?.job.status).toBe("running");
    expect((await store.getJob(finished))?.job.status).toBe("completed");
  });
});

/** Spawn a trivial child, wait for it to exit, and return its (dead) pid. */
async function spawnAndReapPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn produced no pid");
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return pid;
}
