import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("keeps accepting appends after one append fails", async () => {
    // The per-job append queue chains promises; a rejected link must not
    // poison the chain (every later append would silently reject).
    const id = await createJob();
    await store.appendEvent(id, logEvent(id, 1));
    const eventsPath = join(rootDir, "jobs", id, "events.jsonl");
    const original = await readFile(eventsPath, "utf8");
    // Turn the log file into a directory so the next append fails (EISDIR).
    await rm(eventsPath);
    await mkdir(eventsPath);
    await expect(store.appendEvent(id, logEvent(id, 2))).rejects.toThrow();
    // Restore and confirm the queue is still alive with correct numbering.
    await rm(eventsPath, { recursive: true });
    await writeFile(eventsPath, original, "utf8");
    const seq = await store.appendEvent(id, logEvent(id, 3));
    expect(seq).toBe(2);
    const replayed = await store.replayAfter(id, 0);
    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
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
    // Poll until the write stream flushes; a fixed sleep flakes on loaded
    // CI hosts.
    await expect
      .poll(() => readFile(capped.consoleLogPath(id), "utf8"))
      .toContain("truncated");
    const content = await readFile(capped.consoleLogPath(id), "utf8");
    expect(content).toContain("a".repeat(30));
    expect(content).not.toContain("never-written");
  });
});

describe("JobStore.transitionToTerminal", () => {
  it("lets exactly one of two concurrent terminal writers win", async () => {
    // The runner's exit synthesis and the cancel route can race; the
    // primitive serialises check+append+update on the record queue so the
    // one-terminal-per-job contract holds without caller-side re-reads.
    const id = await createJob();
    const event = (error: string) =>
      ({
        type: "training.failed",
        jobId: id,
        timestamp: "2026-01-01T00:00:00Z",
        error,
      }) as const;
    const [first, second] = await Promise.all([
      store.transitionToTerminal(id, event("Job cancelled"), (r) => {
        r.job.status = "cancelled";
        r.job.error = "Job cancelled";
      }),
      store.transitionToTerminal(id, event("trainer exited"), (r) => {
        r.job.status = "failed";
        r.job.error = "trainer exited";
      }),
    ]);
    expect([first, second].toSorted()).toEqual([false, true]);
    const events = await store.replayAfter(id, 0);
    expect(events).toHaveLength(1);
    const record = await store.getJob(id);
    // The stored status matches whichever writer won.
    expect(["cancelled", "failed"]).toContain(record?.job.status);
    expect(events[0]?.event.type).toBe("training.failed");
  });

  it("recovers from a crash between event append and record write", async () => {
    // Simulate a process that appended its terminal event and died before
    // writing job.json: the next transition must converge the record to
    // the persisted event instead of appending a second terminal.
    const id = await createJob();
    await store.appendEvent(id, {
      type: "training.completed",
      jobId: id,
      timestamp: "2026-01-01T00:00:05Z",
      artifacts: [],
    });
    const won = await store.transitionToTerminal(
      id,
      {
        type: "training.failed",
        jobId: id,
        timestamp: "2026-01-01T00:00:06Z",
        error: "interrupted",
      },
      (r) => {
        r.job.status = "failed";
        r.job.error = "interrupted";
      },
    );
    expect(won).toBe(true);
    const events = await store.replayAfter(id, 0);
    expect(events.map((e) => e.event.type)).toEqual(["training.completed"]);
    // The persisted completion outranks the caller's failed intent.
    expect((await store.getJob(id))?.job.status).toBe("completed");
  });

  it("converges a persisted cancelled tail to a cancelled record", async () => {
    // Same crash shape, but the persisted terminal is a cancellation; the
    // record must match what SSE consumers already replayed, not the later
    // writer's generic failure intent.
    const id = await createJob();
    await store.appendEvent(id, {
      type: "training.failed",
      jobId: id,
      timestamp: "2026-01-01T00:00:05Z",
      error: "Job cancelled",
    });
    const won = await store.transitionToTerminal(
      id,
      {
        type: "training.failed",
        jobId: id,
        timestamp: "2026-01-01T00:00:06Z",
        error: "Training was interrupted",
      },
      (r) => {
        r.job.status = "failed";
        r.job.error = "Training was interrupted";
      },
    );
    expect(won).toBe(true);
    expect(await store.replayAfter(id, 0)).toHaveLength(1);
    const record = await store.getJob(id);
    expect(record?.job.status).toBe("cancelled");
    expect(record?.job.error).toBe("Job cancelled");
  });

  it("appendUnlessTerminal appends on live jobs and drops on terminal ones", async () => {
    const id = await createJob();
    const started = await store.appendUnlessTerminal(
      id,
      {
        type: "training.started",
        jobId: id,
        timestamp: "2026-01-01T00:00:00Z",
      },
      (r) => {
        r.job.status = "running";
      },
    );
    expect(started).toBe("appended");
    expect((await store.getJob(id))?.job.status).toBe("running");
    await store.updateJob(id, (r) => {
      r.job.status = "cancelled";
    });
    // A late `started` after cancellation must be dropped, not appended
    // (it would trail the terminal event and resurrect the record).
    const late = await store.appendUnlessTerminal(
      id,
      {
        type: "training.started",
        jobId: id,
        timestamp: "2026-01-01T00:00:01Z",
      },
      (r) => {
        r.job.status = "running";
      },
    );
    expect(late).toBe("terminal");
    expect((await store.getJob(id))?.job.status).toBe("cancelled");
    expect(await store.replayAfter(id, 0)).toHaveLength(1);
  });

  it("reports an unreadable record as gone, not terminal", async () => {
    // A transient read fault (or a deleted job dir) must be
    // distinguishable from "someone else finished the job": the runner
    // latches terminal state only for the latter, so a passing glitch
    // cannot silence the rest of a run.
    const id = await createJob();
    await rm(join(rootDir, "jobs", id, "job.json"));
    const outcome = await store.appendUnlessTerminal(id, logEvent(id, 1));
    expect(outcome).toBe("gone");
    expect(await store.replayAfter(id, 0)).toHaveLength(0);
  });

  it("returns false for unknown jobs and already-terminal jobs", async () => {
    expect(
      await store.transitionToTerminal(
        "00000000-0000-0000-0000-000000000000",
        {
          type: "training.failed",
          jobId: "00000000-0000-0000-0000-000000000000",
          timestamp: "2026-01-01T00:00:00Z",
          error: "x",
        },
        () => undefined,
      ),
    ).toBe(false);
    const id = await createJob();
    await store.updateJob(id, (r) => {
      r.job.status = "completed";
    });
    expect(
      await store.transitionToTerminal(
        id,
        {
          type: "training.failed",
          jobId: id,
          timestamp: "2026-01-01T00:00:00Z",
          error: "x",
        },
        () => undefined,
      ),
    ).toBe(false);
    expect(await store.replayAfter(id, 0)).toHaveLength(0);
  });
});

describe("JobStore.reconcileOrphans", () => {
  it("fails running jobs whose pid is gone and leaves live pids alone", async () => {
    // A real "spawn then reap" dead pid flakes on Windows CI: the OS
    // recycles pids fast enough that the just-dead pid can belong to a
    // fresh unrelated process when reconcile probes it. Injecting the
    // probe keeps the reconcile logic under test deterministic; the real
    // probe (process.kill(pid, 0)) is Node's standard liveness primitive.
    const probed: number[] = [];
    const probingStore = new JobStore({
      rootDir,
      pidProbe: (pid) => {
        probed.push(pid);
        return pid === process.pid;
      },
    });
    const orphaned = await probingStore.createJob({
      name: "orphaned",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    const deadPid = 999_999_999;
    await probingStore.updateJob(orphaned.job.id, (r) => {
      r.job.status = "running";
      r.pid = deadPid;
    });
    const alive = await probingStore.createJob({
      name: "alive",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    await probingStore.updateJob(alive.job.id, (r) => {
      r.job.status = "running";
      r.pid = process.pid;
    });
    const finished = await probingStore.createJob({
      name: "finished",
      config: {
        model: "m",
        datasetSource: { type: "huggingface", name: "x" },
      },
      backendId: "fake",
    });
    await probingStore.updateJob(finished.job.id, (r) => {
      r.job.status = "completed";
    });

    await probingStore.reconcileOrphans();
    probingStore.close();

    // Terminal jobs are skipped before the probe runs.
    expect(probed.toSorted((a, b) => a - b)).toEqual(
      [deadPid, process.pid].toSorted((a, b) => a - b),
    );

    const orphanedRecord = await probingStore.getJob(orphaned.job.id);
    expect(orphanedRecord?.job.status).toBe("failed");
    expect(orphanedRecord?.job.error).toContain("interrupted");
    const orphanEvents = await probingStore.replayAfter(orphaned.job.id, 0);
    expect(orphanEvents.at(-1)?.event.type).toBe("training.failed");

    expect((await probingStore.getJob(alive.job.id))?.job.status).toBe(
      "running",
    );
    expect((await probingStore.getJob(finished.job.id))?.job.status).toBe(
      "completed",
    );
  });

  it("treats a truly dead OS pid as not alive (real probe)", async () => {
    // Realism check for the default probe on POSIX, where pid recycling
    // within a test's lifetime is not a practical concern. Skipped on
    // Windows; the injected-probe test above explains why.
    if (process.platform === "win32") return;
    const deadPid = await spawnAndReapPid();
    const orphaned = await createJob("orphaned");
    await store.updateJob(orphaned, (r) => {
      r.job.status = "running";
      r.pid = deadPid;
    });
    await store.reconcileOrphans();
    expect((await store.getJob(orphaned))?.job.status).toBe("failed");
  });

  it("leaves a fresh pid-less record alone but fails an aged one", async () => {
    // A second instance can list a job the owning instance created moments
    // ago: legitimately `queued` with `pid: null` until its spawn lands.
    // Only pid-less records older than the grace window are abandoned.
    const fresh = await createJob("fresh");
    const aged = await createJob("aged");
    await store.updateJob(aged, (r) => {
      r.job.createdAt = new Date(Date.now() - 11 * 60_000).toISOString();
    });

    await store.reconcileOrphans();

    expect((await store.getJob(fresh))?.job.status).toBe("queued");
    const agedRecord = await store.getJob(aged);
    expect(agedRecord?.job.status).toBe("failed");
    expect(agedRecord?.job.error).toContain("interrupted");
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
