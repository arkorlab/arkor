import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { TrainRunPaths } from "./backends/types";
import type { LocalStreamEvent } from "./protocol";
import type { JobConfig, TrainingJob } from "arkor";

/**
 * Durable store for local training jobs.
 *
 * Layout, one directory per job under `<rootDir>/jobs/<jobId>/`:
 *   job.json      TrainingJob + { pid, backendId }, atomic tmp+rename writes
 *   events.jsonl  `{seq, event}` per line, append-only
 *   run.json      the shim's input, written by the runner before spawn
 *   console.log   non-protocol child output, size-capped
 *   adapters/     `step-<N>/` checkpoints and `final/`, written by the shim
 *   data/         prepared dataset scratch space
 *
 * Durability is what makes three behaviours real rather than best-effort:
 * `Last-Event-ID` replay across server restarts, the Studio jobs list
 * surviving a `arkor dev --local` restart, and crash reconciliation
 * ({@link JobStore.reconcileOrphans}). The event log is JSONL because an
 * append can tear mid-line on crash; the reader tolerates a torn final line
 * by skipping anything that does not parse.
 */

export interface JobRecord {
  job: TrainingJob;
  /** Pid of the supervising child while running; null before/after. */
  pid: number | null;
  backendId: string;
}

export interface StoredEvent {
  seq: number;
  event: LocalStreamEvent;
}

interface JobSubscriber {
  onEvent: (event: StoredEvent) => void;
  onEnd: () => void;
}

interface JobRuntimeState {
  /** Highest sequence number ever appended for this job. */
  seq: number;
  /**
   * Serialises appends per job. The runner appends sequentially, but the
   * cancel route and crash reconciliation can race it; two interleaved
   * appends reading the same `seq` would mint duplicate SSE ids.
   */
  appendQueue: Promise<unknown>;
  /**
   * Serialises `job.json` read-modify-writes per job. Concurrent updateJob
   * calls (the runner's pid write racing the event pipeline's status
   * writes) are safe on POSIX (rename is atomic) but collide on Windows,
   * where renaming over a file another writer has open throws EPERM.
   */
  recordQueue: Promise<unknown>;
  subscribers: Set<JobSubscriber>;
  consoleStream: WriteStream | null;
  consoleBytes: number;
  consoleTruncated: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Cap for console.log so a chatty child cannot fill the disk. */
const MAX_CONSOLE_BYTES = 5 * 1024 * 1024;

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class JobStore {
  private readonly jobsDir: string;
  private readonly consoleByteCap: number;
  private readonly pidProbe: (pid: number) => boolean;
  private readonly runtime = new Map<string, JobRuntimeState>();

  constructor(options: {
    rootDir: string;
    consoleByteCap?: number;
    /**
     * Pid liveness probe used by {@link reconcileOrphans}. Injectable for
     * tests: a real "spawn then reap" pid is racy on Windows, where the OS
     * recycles pids aggressively enough that a just-dead pid can belong to
     * a fresh unrelated process by the time the probe runs.
     *
     * @internal
     */
    pidProbe?: (pid: number) => boolean;
  }) {
    this.jobsDir = join(options.rootDir, "jobs");
    this.consoleByteCap = options.consoleByteCap ?? MAX_CONSOLE_BYTES;
    this.pidProbe = options.pidProbe ?? isPidAlive;
  }

  jobDir(jobId: string): string {
    return join(this.jobsDir, jobId);
  }

  paths(jobId: string, shimDir: string): TrainRunPaths {
    const jobDir = this.jobDir(jobId);
    return {
      jobDir,
      runJsonPath: join(jobDir, "run.json"),
      adaptersDir: join(jobDir, "adapters"),
      dataDir: join(jobDir, "data"),
      shimDir,
    };
  }

  consoleLogPath(jobId: string): string {
    return join(this.jobDir(jobId), "console.log");
  }

  async createJob(input: {
    name: string;
    config: JobConfig;
    backendId: string;
  }): Promise<JobRecord> {
    const id = randomUUID();
    const jobDir = this.jobDir(id);
    await mkdir(join(jobDir, "adapters"), { recursive: true });
    await mkdir(join(jobDir, "data"), { recursive: true });
    const record: JobRecord = {
      job: {
        id,
        orgId: "local",
        projectId: "local",
        name: input.name,
        status: "queued",
        config: input.config,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      },
      pid: null,
      backendId: input.backendId,
    };
    await this.writeRecord(record);
    this.ensureRuntime(id).seq = 0;
    return record;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const file = join(this.jobDir(jobId), "job.json");
    let raw: string;
    try {
      // Retried because Windows can transiently fail a read that overlaps
      // an in-flight atomic rename (EPERM/EBUSY); treating that as
      // "missing job" would misroute callers into not-found branches.
      raw = await retryWindowsFileLocks(() => readFile(file, "utf8"));
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as JobRecord;
    } catch {
      return null;
    }
  }

  /** All jobs, newest first. Unreadable directories are skipped. */
  async listJobs(): Promise<TrainingJob[]> {
    let entries: string[];
    try {
      entries = await readdir(this.jobsDir);
    } catch {
      return [];
    }
    // Bounded fan-out: a project that accumulated hundreds of runs must
    // not open one file descriptor per job at once (EMFILE would silently
    // drop jobs from the list via getJob's null path).
    const CONCURRENCY = 16;
    const records: (JobRecord | null)[] = [];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const chunk = entries.slice(i, i + CONCURRENCY);
      records.push(...(await Promise.all(chunk.map((id) => this.getJob(id)))));
    }
    return records
      .filter((r): r is JobRecord => r !== null)
      .map((r) => r.job)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Read-modify-write `job.json`. Cross-PROCESS locking is unnecessary
   * (only the server instance that created a job, or reconciled it as
   * orphaned, mutates it), but in-process callers are serialised through
   * the per-job record queue below.
   */
  async updateJob(
    jobId: string,
    mutate: (record: JobRecord) => void,
  ): Promise<JobRecord> {
    // Serialised per job (see JobRuntimeState.recordQueue): the runner's
    // fire-and-forget pid write and the event pipeline's status writes may
    // call this concurrently, and interleaved read-modify-writes would both
    // lose updates and hit Windows rename locking.
    const state = this.ensureRuntime(jobId);
    const task = state.recordQueue.then(async () => {
      const record = await this.getJob(jobId);
      if (!record) throw new Error(`unknown local job: ${jobId}`);
      mutate(record);
      await this.writeRecord(record);
      return record;
    });
    state.recordQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * Atomically record a job's terminal transition: append the terminal
   * stream event and update the record, iff the job is not already
   * terminal. The check and both writes run as ONE task on the per-job
   * record queue, so concurrent in-process writers (the runner's exit
   * synthesis, the cancel route, reconcileOrphans) cannot each pass a
   * separate check-then-write; exactly one wins and the rest observe
   * `false`. Writers in OTHER processes sharing `.arkor/local/` still
   * race (documented limitation of the shared-store setup).
   *
   * The caller owns the follow-up `notifyEnded` (only when `true`).
   */
  async transitionToTerminal(
    jobId: string,
    event: LocalStreamEvent,
    mutate: (record: JobRecord) => void,
  ): Promise<boolean> {
    const state = this.ensureRuntime(jobId);
    const task = state.recordQueue.then(async () => {
      const record = await this.getJob(jobId);
      if (!record || isTerminalStatus(record.job.status)) return false;
      // appendEvent chains on the separate per-job append queue; that
      // queue never waits on the record queue, so awaiting it from inside
      // this record-queue task cannot deadlock.
      await this.appendEvent(jobId, event);
      mutate(record);
      await this.writeRecord(record);
      return true;
    });
    state.recordQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * Append an event to the job's log and fan it out to live subscribers.
   * Returns the sequence id (the SSE `id:` field). Failures propagate: a
   * job whose history cannot be written must fail loudly, not silently
   * drop events.
   */
  async appendEvent(jobId: string, event: LocalStreamEvent): Promise<number> {
    const state = this.ensureRuntime(jobId);
    const task = state.appendQueue.then(async () => {
      if (state.seq === 0) {
        // First append since this store instance loaded the job: continue
        // the on-disk numbering so `Last-Event-ID` stays monotonic across
        // restarts, and terminate any torn final line a crash left behind
        // (appending straight after the fragment would corrupt the NEXT
        // event too: fragment + event would parse as one malformed line).
        const tail = await this.loadPersistedTail(jobId);
        state.seq = tail.seq;
        if (tail.tornTail) {
          await appendFile(
            join(this.jobDir(jobId), "events.jsonl"),
            "\n",
            "utf8",
          );
        }
      }
      const seq = state.seq + 1;
      const line = `${JSON.stringify({ seq, event })}\n`;
      await appendFile(join(this.jobDir(jobId), "events.jsonl"), line, "utf8");
      state.seq = seq;
      const stored: StoredEvent = { seq, event };
      for (const subscriber of state.subscribers) subscriber.onEvent(stored);
      return seq;
    });
    // The queue must survive a failed append (the caller sees the rejection;
    // the next append should not).
    state.appendQueue = task.catch(() => undefined);
    return task;
  }

  /** Events with `seq > afterSeq`, in order. */
  async replayAfter(jobId: string, afterSeq: number): Promise<StoredEvent[]> {
    const events = await this.readEvents(jobId);
    return events.filter((e) => e.seq > afterSeq);
  }

  /**
   * Subscribe to live events for a job. The listener receives every event
   * appended after the call plus an `end` notification when the job reaches
   * a terminal status. Returns an unsubscribe function.
   */
  subscribe(
    jobId: string,
    listeners: {
      onEvent: (event: StoredEvent) => void;
      onEnd: () => void;
    },
  ): () => void {
    const state = this.ensureRuntime(jobId);
    const subscriber: JobSubscriber = listeners;
    state.subscribers.add(subscriber);
    return () => {
      state.subscribers.delete(subscriber);
    };
  }

  /** Notify live subscribers that the job reached a terminal status. */
  notifyEnded(jobId: string): void {
    for (const subscriber of this.ensureRuntime(jobId).subscribers) {
      subscriber.onEnd();
    }
  }

  /**
   * Append non-protocol child output to `console.log`, capped at
   * {@link MAX_CONSOLE_BYTES} with an explicit truncation notice so a chatty
   * child cannot fill the disk while the file still explains itself.
   */
  appendConsole(jobId: string, text: string): void {
    // Straggler writes after close() (a child's buffered stderr draining
    // during shutdown) must not re-open a stream that would never be
    // flushed again.
    if (this.closed) return;
    const state = this.ensureRuntime(jobId);
    if (state.consoleTruncated) return;
    if (!state.consoleStream) {
      const stream = createWriteStream(this.consoleLogPath(jobId), {
        flags: "a",
      });
      // A failed open or write (ENOSPC, EACCES, tree removed) emits
      // 'error' on the stream; without a listener that is an uncaught
      // exception that would take down the whole server process over a
      // diagnostics file. Disable console capture for this job instead.
      stream.on("error", () => {
        state.consoleTruncated = true;
        state.consoleStream = null;
      });
      state.consoleStream = stream;
    }
    const remaining = this.consoleByteCap - state.consoleBytes;
    const size = Buffer.byteLength(text);
    if (size >= remaining) {
      // Write only the remaining budget (a single oversized chunk must not
      // blow past the cap; a torn multi-byte character is acceptable in a
      // diagnostics file), stamp the truncation notice, and close the
      // stream so the handle is not held for the rest of the session.
      state.consoleTruncated = true;
      const stream = state.consoleStream;
      state.consoleStream = null;
      if (remaining > 0) {
        stream.write(Buffer.from(text).subarray(0, remaining));
      }
      stream.end("\n[arkor] console output truncated (size cap reached)\n");
      return;
    }
    state.consoleBytes += size;
    state.consoleStream.write(text);
  }

  /** Flush and close per-job console streams. */
  close(): void {
    this.closed = true;
    for (const state of this.runtime.values()) {
      state.consoleStream?.end();
      state.consoleStream = null;
    }
  }

  private closed = false;

  /**
   * Mark jobs that claim to be running but whose supervising process is
   * gone (crash, SIGKILL, power loss) as failed, so the UI and SDK never
   * see a phantom "running" job after a restart.
   *
   * Two guards make this safe with a second `arkor dev --local` instance
   * sharing `.arkor/local/`:
   *   - pid liveness: instance A sees instance B's running jobs, but their
   *     pids are alive, so A leaves them alone;
   *   - a grace age for pid-less non-terminal records: a job that instance
   *     B created moments ago is legitimately `queued` with `pid: null`
   *     until its spawn lands, so only records older than the grace window
   *     are treated as abandoned.
   */
  async reconcileOrphans(): Promise<void> {
    const PRE_SPAWN_GRACE_MS = 10 * 60_000;
    const jobs = await this.listJobs();
    for (const job of jobs) {
      if (isTerminalStatus(job.status)) continue;
      const record = await this.getJob(job.id);
      if (!record) continue;
      if (record.pid !== null && this.pidProbe(record.pid)) continue;
      if (record.pid === null) {
        const age = Date.now() - Date.parse(record.job.createdAt);
        if (!(Number.isFinite(age) && age > PRE_SPAWN_GRACE_MS)) continue;
      }
      // transitionToTerminal re-reads inside the record queue, so an
      // in-process writer (this instance's own runner or cancel route)
      // that terminalised the job while this loop was mid-flight wins and
      // this pass backs off.
      const timestamp = new Date().toISOString();
      const error =
        "Training was interrupted (local server or trainer process exited)";
      const won = await this.transitionToTerminal(
        job.id,
        { type: "training.failed", jobId: job.id, timestamp, error },
        (r) => {
          r.job.status = "failed";
          r.job.error = error;
          r.job.completedAt = timestamp;
          r.pid = null;
        },
      );
      if (won) this.notifyEnded(job.id);
    }
  }

  private ensureRuntime(jobId: string): JobRuntimeState {
    let state = this.runtime.get(jobId);
    if (!state) {
      state = {
        seq: 0,
        appendQueue: Promise.resolve(),
        recordQueue: Promise.resolve(),
        subscribers: new Set(),
        consoleStream: null,
        consoleBytes: 0,
        consoleTruncated: false,
      };
      this.runtime.set(jobId, state);
    }
    return state;
  }

  private async loadPersistedTail(
    jobId: string,
  ): Promise<{ seq: number; tornTail: boolean }> {
    const file = join(this.jobDir(jobId), "events.jsonl");
    let raw: string;
    try {
      raw = await retryWindowsFileLocks(() => readFile(file, "utf8"));
    } catch {
      return { seq: 0, tornTail: false };
    }
    const events = parseEventLines(raw);
    return {
      seq: events.at(-1)?.seq ?? 0,
      tornTail: raw.length > 0 && !raw.endsWith("\n"),
    };
  }

  private async readEvents(jobId: string): Promise<StoredEvent[]> {
    const file = join(this.jobDir(jobId), "events.jsonl");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return [];
    }
    return parseEventLines(raw);
  }

  private async writeRecord(record: JobRecord): Promise<void> {
    const jobDir = this.jobDir(record.job.id);
    await mkdir(jobDir, { recursive: true });
    const file = join(jobDir, "job.json");
    // Atomic tmp+rename (the credentials.ts pattern): a reader never sees a
    // half-written job.json, even if the process dies mid-write. The rename
    // is retried because Windows fails it with EPERM while any reader (an
    // SSE route's getJob, a jobs-list scan) briefly holds the destination
    // open; those windows are microseconds long.
    const tmp = `${file}.${String(process.pid)}.tmp`;
    // 0600 (owner-only): the job config can carry a blob dataset bearer
    // token, which must not be readable by other local accounts in a shared
    // project or CI workspace. rename preserves the tmp file's mode.
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await retryWindowsFileLocks(() => rename(tmp, file));
  }
}

function parseEventLines(raw: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<StoredEvent>;
      if (typeof parsed.seq === "number" && parsed.event !== undefined) {
        events.push({ seq: parsed.seq, event: parsed.event });
      }
    } catch {
      // A torn final line from a crash mid-append; skip it. Anything
      // after a tear cannot exist (appends are sequential).
    }
  }
  return events;
}

const RETRYABLE_FS_CODES = new Set(["EPERM", "EBUSY"]);

/**
 * Retry transient Windows file-locking failures (rename over an open file,
 * read overlapping a rename). Gated to Windows: on POSIX these codes mean
 * real permission problems that deserve to surface immediately, and EACCES
 * is deliberately NOT retried anywhere for the same reason.
 */
async function retryWindowsFileLocks<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "win32") return operation();
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE_FS_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/** True when signal 0 delivery indicates the pid exists (EPERM counts). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
