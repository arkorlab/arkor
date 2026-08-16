import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { parseProtocolLine, toStreamEvent } from "./protocol";
import { isTerminalStatus } from "./store";

import type {
  LocalTrainingBackend,
  RunSpec,
  TrainRunPaths,
} from "./backends/types";
import type { JobStore } from "./store";
import type { JobConfig } from "arkor";

export interface RunManagerOptions {
  store: JobStore;
  /** Injectable spawn for tests; production uses node:child_process. */
  spawnImpl?: typeof nodeSpawn;
  /** Grace between SIGTERM and SIGKILL on cancel/shutdown. Default 5000. */
  gracePeriodMs?: number;
}

interface LiveRun {
  child: ChildProcess;
  /** Set when cancel() ran; changes how exit is reported. */
  cancelRequested: boolean;
  /** Set once a terminal event was appended, from any path. */
  terminalRecorded: boolean;
  killTimer: NodeJS.Timeout | null;
  /** Resolves once the run's terminal event has been recorded. */
  done: Promise<void>;
  resolveDone: () => void;
}

/**
 * Supervises training children. Backend-agnostic: it spawns whatever
 * {@link RunSpec} the backend built, classifies stdout lines through the
 * shim protocol, and turns everything (protocol events, crashes, cancels)
 * into stored stream events with correct terminal accounting.
 */
export class RunManager {
  private readonly store: JobStore;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly gracePeriodMs: number;
  private readonly live = new Map<string, LiveRun>();
  /**
   * Jobs cancelled before their child spawned (cancel raced startRun's
   * async run.json write). startRun consults this to skip or kill the
   * spawn; entries are removed as soon as they are honoured.
   */
  private readonly preSpawnCancelled = new Set<string>();

  constructor(options: RunManagerOptions) {
    this.store = options.store;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.gracePeriodMs = options.gracePeriodMs ?? 5000;
  }

  /** Number of live children (diagnostics / tests). */
  get liveCount(): number {
    return this.live.size;
  }

  /**
   * Launch a training run for an already-created job. Resolves once the
   * child is spawned (not when training ends); all failure paths end in a
   * `training.failed` event rather than a rejection so HTTP callers can
   * treat this as fire-and-forget after the 201.
   */
  async startRun(args: {
    jobId: string;
    config: JobConfig;
    backend: LocalTrainingBackend;
    paths: TrainRunPaths;
  }): Promise<void> {
    const { jobId, config, backend, paths } = args;
    try {
      const run = backend.buildTrainRun({ config, paths });
      // 0600: run.json can carry the blob dataset bearer token; keep it
      // owner-only in shared project / CI workspaces (same as job.json).
      await writeFile(
        paths.runJsonPath,
        `${JSON.stringify(run.runJson, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      for (const warning of run.warnings) {
        this.store.appendConsole(jobId, `[arkor] ${warning}\n`);
      }
      // A cancel can land while the awaits above are in flight; at that
      // point there is no live child, so `cancel()` parked the request in
      // `preSpawnCancelled` and the caller terminalised the record. Honour
      // it here instead of spawning a child for a job that already ended.
      // The same applies when the whole server shut down mid-launch.
      if (this.closed) {
        await this.recordFailure(jobId, "local server shut down before launch");
        return;
      }
      if (this.preSpawnCancelled.delete(jobId)) return;
      this.spawnChild(jobId, run.spec, paths);
      // Belt for the residual microtask window: a cancel that raced the
      // check above finds the child live on its own retry path below, but
      // one that landed between the check and the spawn returns false to
      // its caller while a child now exists. Sweep it up.
      if (this.preSpawnCancelled.delete(jobId)) {
        await this.cancel(jobId);
      }
    } catch (error) {
      await this.recordFailure(
        jobId,
        `failed to launch training: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Cancel a run. SIGTERM to the whole process group (uv sits between the
   * runner and python, so signalling only the direct child would leave the
   * trainer alive), then SIGKILL after the grace period. Safe during any
   * phase, including dataset download. Resolves once the terminal event is
   * recorded. No-op (false) when the job has no live child.
   */
  async cancel(jobId: string): Promise<boolean> {
    const run = this.live.get(jobId);
    if (!run) {
      // No live child YET: either the job truly has none, or startRun is
      // mid-flight between job creation and spawn. Park the cancellation so
      // startRun skips (or kills) the spawn; the caller terminalises the
      // job record itself when it sees `false`.
      this.preSpawnCancelled.add(jobId);
      return false;
    }
    run.cancelRequested = true;
    this.signal(run.child, "SIGTERM");
    run.killTimer = setTimeout(() => {
      this.signal(run.child, "SIGKILL");
    }, this.gracePeriodMs);
    run.killTimer.unref();
    // `done` (not the raw 'close' event) so callers observe the terminal
    // event already recorded, not just the process gone.
    await run.done;
    return true;
  }

  /**
   * Drop a parked pre-spawn cancellation. Called by the cancel route once
   * it has terminalised (or found already terminal) the job record itself:
   * the jobId will never start again, so a stale entry would only leak.
   */
  forgetPreSpawnCancel(jobId: string): void {
    this.preSpawnCancelled.delete(jobId);
  }

  /** Kill every live child; used when the local server shuts down. */
  async closeAll(): Promise<void> {
    // Set before cancelling so a startRun still awaiting its run.json
    // write cannot spawn a child into a closed server.
    this.closed = true;
    await Promise.all([...this.live.keys()].map((jobId) => this.cancel(jobId)));
  }

  private closed = false;

  private spawnChild(jobId: string, spec: RunSpec, paths: TrainRunPaths): void {
    const child = this.spawnImpl(spec.command, spec.argv, {
      cwd: spec.cwd ?? paths.jobDir,
      env: {
        ...process.env,
        ...spec.env,
        // Python block-buffers stdout when piped; without this the protocol
        // lines arrive in multi-kilobyte bursts minutes apart.
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      // A process group lets cancel/shutdown signal uv AND python. Windows
      // has no process groups; child.kill() is the whole story there (the
      // MLX backend never runs on Windows, but the runner stays generic).
      detached: process.platform !== "win32",
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const run: LiveRun = {
      child,
      cancelRequested: false,
      terminalRecorded: false,
      killTimer: null,
      done,
      resolveDone,
    };
    this.live.set(jobId, run);
    this.attachReaper(child);

    // Record the supervising pid so a later `reconcileOrphans` can tell a
    // live run from a crashed one. Serialised against the event pipeline's
    // status writes by the store's per-job record queue. A failure is
    // logged (not fatal): the run itself is healthy, but a pid-less
    // running record would be mis-reconciled as an orphan after a crash.
    void this.store
      .updateJob(jobId, (r) => {
        r.pid = child.pid ?? null;
      })
      .catch((error: unknown) => {
        this.store.appendConsole(
          jobId,
          `[arkor] failed to record the trainer pid (${error instanceof Error ? error.message : String(error)}); ` +
            "crash reconciliation may misjudge this job after a restart\n",
        );
      });

    // Serialise event handling: protocol lines mutate job.json and append
    // to events.jsonl, and ordering is part of the contract.
    let pipeline = Promise.resolve();
    const enqueue = (task: () => Promise<void>) => {
      pipeline = pipeline.then(task).catch(async (error: unknown) => {
        // This handler must NEVER throw: a rejected link would skip every
        // later `.then` task in the chain, including the terminal
        // synthesis and the `resolveDone()` task, leaving `run.done`
        // unresolved forever (cancel()/closeAll() would hang and the SDK's
        // wait() would spin on pings).
        try {
          await this.recordFailure(
            jobId,
            `failed to record training progress: ${error instanceof Error ? error.message : String(error)}`,
          );
        } catch {
          // The store itself is failing (disk full, tree removed): there
          // is nowhere left to record. Killing the child below is the
          // remaining safety action.
        }
        this.signal(child, "SIGKILL");
      });
    };

    const handleLine = (line: string) => {
      const parsed = parseProtocolLine(line);
      if (parsed.kind === "console") {
        this.store.appendConsole(jobId, `${line}\n`);
        return;
      }
      if (parsed.kind === "invalid") {
        this.store.appendConsole(
          jobId,
          `[arkor] skipped malformed protocol line (${parsed.error}): ${line}\n`,
        );
        return;
      }
      enqueue(() => this.handleShimEvent(jobId, run, parsed.event));
    };

    const stdoutSplitter = makeLineSplitter(handleLine);
    const stderrSplitter = makeLineSplitter((line) => {
      this.store.appendConsole(jobId, `${line}\n`);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSplitter.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSplitter.push(chunk);
    });

    child.on("error", (error) => {
      // Spawn failure (ENOENT and friends): no `close` may follow.
      enqueue(async () => {
        if (run.terminalRecorded) return;
        run.terminalRecorded = true;
        if (await this.storeAlreadyTerminal(jobId)) return;
        await this.failJob(jobId, `failed to start trainer: ${error.message}`);
      });
      // Chained behind the terminal task above, so `run.done` observers see
      // the terminal event already recorded.
      enqueue(async () => {
        run.resolveDone();
      });
      this.finishRun(jobId, run);
    });

    child.on("close", (code, signal) => {
      stdoutSplitter.flush();
      stderrSplitter.flush();
      enqueue(async () => {
        if (run.terminalRecorded) return;
        run.terminalRecorded = true;
        // The record can already be terminal when a pre-spawn cancel
        // terminalised it and the belt path in startRun killed this child
        // afterwards; synthesising a second terminal event would corrupt
        // the stream contract (exactly one terminal per job).
        if (await this.storeAlreadyTerminal(jobId)) return;
        if (run.cancelRequested) {
          await this.failJob(jobId, "Job cancelled", "cancelled");
          return;
        }
        const consolePath = this.store.consoleLogPath(jobId);
        if (code === 0) {
          // Exit 0 without a `completed` protocol event is a shim bug, not
          // a success; surfacing it keeps the contract honest.
          await this.failJob(
            jobId,
            "trainer exited without reporting a result " +
              `(protocol violation); see ${consolePath}`,
          );
          return;
        }
        // `code` is null when a signal terminated the child (external
        // kill, OOM killer, the process-exit reaper); report the signal
        // instead of the meaningless "code null".
        const cause =
          code === null
            ? `was terminated by ${signal ?? "an unknown signal"}`
            : `exited with code ${String(code)}`;
        await this.failJob(jobId, `trainer ${cause}; see ${consolePath}`);
      });
      // Chained behind the terminal task above, so `run.done` observers see
      // the terminal event already recorded.
      enqueue(async () => {
        run.resolveDone();
      });
      this.finishRun(jobId, run);
    });
  }

  private async handleShimEvent(
    jobId: string,
    run: LiveRun,
    event: Parameters<typeof toStreamEvent>[0],
  ): Promise<void> {
    // A cancel beat the shim to the terminal event: the cancel path owns
    // the job's ending, so late shim events (already-buffered `completed`,
    // straggler logs) are dropped instead of double-terminating.
    if (run.terminalRecorded) return;
    const timestamp = new Date().toISOString();
    const streamEvent = toStreamEvent(event, jobId, timestamp);
    if (await this.storeAlreadyTerminal(jobId)) {
      // Someone else terminalised the record while this child was still
      // running (a cancel that raced the exit, or a second server instance
      // sharing `.arkor/local/`). Every event type is dropped, not just the
      // terminal ones: appending another terminal would violate the
      // one-terminal-per-job contract, a late `started` would flip the
      // status back to running (resurrecting a cancelled job and unlocking
      // a second terminal from the exit synthesis), and log/checkpoint
      // events would trail after the stream's `end`.
      run.terminalRecorded = true;
      return;
    }
    await this.store.appendEvent(jobId, streamEvent);
    switch (streamEvent.type) {
      case "training.started": {
        await this.store.updateJob(jobId, (r) => {
          r.job.status = "running";
          r.job.startedAt = timestamp;
        });
        break;
      }
      case "training.completed": {
        run.terminalRecorded = true;
        await this.store.updateJob(jobId, (r) => {
          r.job.status = "completed";
          r.job.completedAt = timestamp;
          r.pid = null;
        });
        this.store.notifyEnded(jobId);
        break;
      }
      case "training.failed": {
        run.terminalRecorded = true;
        await this.store.updateJob(jobId, (r) => {
          r.job.status = "failed";
          r.job.error = streamEvent.error;
          r.job.completedAt = timestamp;
          r.pid = null;
        });
        this.store.notifyEnded(jobId);
        break;
      }
      default:
        break;
    }
  }

  /** Append a `training.failed` and set the job's terminal status. */
  private async failJob(
    jobId: string,
    error: string,
    status: "failed" | "cancelled" = "failed",
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.store.appendEvent(jobId, {
      type: "training.failed",
      jobId,
      timestamp,
      error,
    });
    await this.store.updateJob(jobId, (r) => {
      r.job.status = status;
      r.job.error = error;
      r.job.completedAt = timestamp;
      r.pid = null;
    });
    this.store.notifyEnded(jobId);
  }

  /**
   * Failure before/without a live run (buildTrainRun threw, run.json write
   * failed). Distinct from failJob so callers without a LiveRun can use it.
   */
  private async recordFailure(jobId: string, error: string): Promise<void> {
    if (await this.storeAlreadyTerminal(jobId)) return;
    await this.failJob(jobId, error);
  }

  private async storeAlreadyTerminal(jobId: string): Promise<boolean> {
    const record = await this.store.getJob(jobId);
    return record !== null && isTerminalStatus(record.job.status);
  }

  private finishRun(jobId: string, run: LiveRun): void {
    if (run.killTimer) clearTimeout(run.killTimer);
    this.live.delete(jobId);
    this.detachReaper(run.child);
  }

  private signal(child: ChildProcess, sig: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && typeof child.pid === "number") {
        // Negative pid addresses the whole process group (uv + python).
        process.kill(-child.pid, sig);
        return;
      }
    } catch {
      // Group is gone or not ours anymore; fall through to the direct kill.
    }
    try {
      child.kill(sig);
    } catch {
      // Already exited.
    }
  }

  // One refcounted process 'exit' listener (attached while any child is
  // live, detached at zero) so concurrent runs cannot accumulate listeners;
  // the same pattern the Studio server uses for /api/train children.
  private readonly exitChildren = new Set<ChildProcess>();
  private readonly killOnExit = (): void => {
    for (const child of this.exitChildren) {
      this.signal(child, "SIGKILL");
    }
  };

  private attachReaper(child: ChildProcess): void {
    this.exitChildren.add(child);
    if (this.exitChildren.size === 1) {
      process.on("exit", this.killOnExit);
    }
  }

  private detachReaper(child: ChildProcess): void {
    this.exitChildren.delete(child);
    if (this.exitChildren.size === 0) {
      process.removeListener("exit", this.killOnExit);
    }
  }
}

/**
 * Incremental newline splitter that is safe against chunks tearing lines
 * (and multi-byte characters) at arbitrary byte boundaries.
 *
 * The carry is bounded: a child that streams without ever emitting a
 * newline (a `\r`-redrawing progress bar is the ordinary case) would
 * otherwise grow the buffer without limit and pay quadratic re-copying.
 * Past the cap the partial line is force-flushed as console output; only
 * protocol lines need exact line framing, and those are short and always
 * newline-terminated.
 */
const MAX_CARRY_BYTES = 1024 * 1024;

function makeLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer): void;
  flush(): void;
} {
  const NEWLINE_BYTE = 10;
  let carry: Buffer = Buffer.alloc(0);
  const drain = () => {
    if (carry.length === 0) return;
    const line = carry.toString("utf8").replace(/\r$/, "");
    carry = Buffer.alloc(0);
    onLine(line);
  };
  return {
    push(chunk: Buffer) {
      carry = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let idx = carry.indexOf(NEWLINE_BYTE);
      while (idx !== -1) {
        const line = carry.subarray(0, idx).toString("utf8").replace(/\r$/, "");
        carry = carry.subarray(idx + 1);
        onLine(line);
        idx = carry.indexOf(NEWLINE_BYTE);
      }
      if (carry.length > MAX_CARRY_BYTES) drain();
    },
    flush: drain,
  };
}
