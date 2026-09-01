import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  statSync,
  type WriteStream,
} from "node:fs";
import { connect, createServer } from "node:net";

import type { LocalTrainingBackend } from "./backends/types";
import type { ChatProxy } from "./server";

export interface InferenceManagerOptions {
  backend: LocalTrainingBackend;
  shimDir: string;
  /** File receiving the inference child's stdout/stderr. */
  logFile: string;
  spawnImpl?: typeof nodeSpawn;
  /**
   * How long to wait for the inference server to accept connections. The
   * first request for a model may download it from HuggingFace, so this is
   * deliberately generous. Default 10 minutes.
   */
  readinessTimeoutMs?: number;
  /** Idle time after which the child is stopped to free unified memory. */
  idleShutdownMs?: number;
}

interface LiveInferenceChild {
  key: string;
  child: ChildProcess;
  port: number;
  ready: Promise<void>;
  dead: boolean;
}

const DEFAULT_READINESS_TIMEOUT_MS = 10 * 60_000;
/** Session cap for inference.log, same size as the per-job console cap. */
const INFERENCE_LOG_BYTE_CAP = 5 * 1024 * 1024;

const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;
const READINESS_POLL_INTERVAL_MS = 250;

/**
 * Lazily-managed OpenAI-compatible inference child (for MLX:
 * `mlx_lm server`). At most one child lives at a time, keyed by
 * `(model, adapterPath)`:
 *   - a request for a different key gracefully replaces the child (a laptop
 *     rarely fits two models in memory),
 *   - an idle timeout stops the child so long-running `arkor dev --local`
 *     sessions do not pin gigabytes of unified memory,
 *   - a crashed child is detected and respawned on the next request.
 *
 * Requests are proxied as OpenAI `/v1/chat/completions` calls and the
 * response body (SSE `data: {"choices":[{"delta":...}]}` frames ending in
 * `data: [DONE]`, or a plain JSON object for `stream: false`) is passed
 * through untouched. That shape is exactly what the cloud returns, so the
 * SDK's `CheckpointContext.infer` and Studio's Playground work unchanged.
 */
export class InferenceManager implements ChatProxy {
  private readonly backend: LocalTrainingBackend;
  private readonly shimDir: string;
  private readonly logFile: string;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly readinessTimeoutMs: number;
  private readonly idleShutdownMs: number;

  private current: LiveInferenceChild | null = null;
  /** Serialises spawn/replace decisions across concurrent requests. */
  private ensureChain: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private logStream: WriteStream | null = null;
  private logBytes = 0;
  private logTruncated = false;
  /** Requests (including their streamed bodies) currently in flight. */
  private inFlight = 0;

  constructor(options: InferenceManagerOptions) {
    this.backend = options.backend;
    this.shimDir = options.shimDir;
    this.logFile = options.logFile;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.readinessTimeoutMs =
      options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  }

  /**
   * Body-lifecycle contract: the caller MUST consume or cancel the
   * returned `Response.body`. The in-flight refcount (which parks the idle
   * shutdown timer) is released only when the monitored body settles, so a
   * dropped, unread body pins the inference child in memory until the
   * process exits. The HTTP route hands ownership to the framework, which
   * always drains or cancels; direct callers of the exported manager get
   * the same obligation.
   */
  async handleChat(args: {
    model: string;
    adapterPath: string | null;
    body: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<Response> {
    const { model, adapterPath, body, signal } = args;
    // Refcount the in-flight window and disarm the idle timer for its
    // duration: a stale timer armed by an earlier request must not fire
    // while a spawn (possibly minutes of model download) or a live
    // generation is in progress and kill the very child being used. The
    // window covers the streamed BODY too (via the monitored passthrough
    // below), not just the response headers: a generation longer than the
    // idle timeout must not have its child shot mid-stream.
    this.beginRequest();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.endRequest();
    };
    let response: Response;
    try {
      response = await this.proxyChat(model, adapterPath, body, signal);
    } catch (error) {
      settle();
      throw error;
    }
    const upstreamBody = response.body;
    if (!upstreamBody) {
      settle();
      return response;
    }
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    // Both outcomes (clean end, client cancel / upstream error) settle.
    upstreamBody.pipeTo(writable).then(settle).catch(settle);
    return new Response(readable, {
      status: response.status,
      headers: response.headers,
    });
  }

  private beginRequest(): void {
    this.inFlight += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private endRequest(): void {
    this.inFlight -= 1;
    if (this.inFlight === 0) this.touchIdleTimer();
  }

  private async proxyChat(
    model: string,
    adapterPath: string | null,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    // A requester that is already gone must not trigger a spawn or pin a
    // (potentially minutes-long, model-downloading) readiness wait; the
    // wait below is likewise abandoned on abort while the child itself is
    // left to finish warming up for the next request.
    if (signal.aborted) return new Response(null, { status: 499 });
    let child: LiveInferenceChild;
    try {
      child = await abortable(this.ensureChild(model, adapterPath), signal);
    } catch (error) {
      // The early return above narrows `signal.aborted` to false, but the
      // flag flips asynchronously while ensureChild is awaited; the check
      // is real, not dead.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) return new Response(null, { status: 499 });
      return Response.json(
        {
          error:
            `local inference server failed to start: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `(see ${this.logFile})`,
        },
        { status: 502 },
      );
    }

    let upstream: Response;
    try {
      upstream = await fetch(
        `http://127.0.0.1:${String(child.port)}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toOpenAiChatBody(model, body)),
          signal,
        },
      );
    } catch (error) {
      // Same as above: aborted can flip during the awaited fetch.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) {
        // The requester is gone; the child stays warm for the next call.
        return new Response(null, { status: 499 });
      }
      // The child is unreachable mid-flight. Usually it died, but a live
      // process that merely reset the connection must not survive being
      // marked dead: `dead: true` makes both ensureChild's replace path
      // and closeAll skip stopping it, which would leave a detached MLX
      // process holding the model in memory. Stop it explicitly (no-op if
      // it already exited) and track the stop for closeAll.
      child.dead = true;
      this.trackStop(stopChild(child.child));
      return Response.json(
        {
          error:
            `local inference server is not responding: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `(see ${this.logFile})`,
        },
        { status: 502 },
      );
    }
    const headers = new Headers();
    headers.set(
      "content-type",
      upstream.headers.get("content-type") ?? "application/json",
    );
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      headers.set("cache-control", "no-cache, no-transform");
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  /**
   * Size-capped append to inference.log, mirroring the job store's console
   * cap: the file persists across restarts in the project's `.arkor/local/`
   * and a verbose or crash-looping `mlx_lm server` must not fill the disk.
   * `this.logStream` is re-read per chunk because the stream's 'error'
   * handler nulls it out.
   */
  private writeLog(chunk: Buffer): void {
    const stream = this.logStream;
    if (!stream || this.logTruncated) return;
    const remaining = INFERENCE_LOG_BYTE_CAP - this.logBytes;
    if (chunk.length >= remaining) {
      this.logTruncated = true;
      this.logStream = null;
      if (remaining > 0) stream.write(chunk.subarray(0, remaining));
      stream.end("\n[arkor] inference log truncated (size cap reached)\n");
      return;
    }
    this.logBytes += chunk.length;
    stream.write(chunk);
  }

  /** Stop the child and cancel timers; used on server shutdown. */
  async closeAll(): Promise<void> {
    // Refuse new spawns first, then wait for any in-flight ensureChild:
    // snapshotting `this.current` without the wait could miss a child
    // mid-spawn, orphan it, and detach the very exit reaper that would
    // have killed it. The wait is short even when a model is still
    // downloading: waitForPort polls `closed` and abandons the readiness
    // wait (its catch then stops that child), so shutdown is bounded by
    // one poll interval, not the 10-minute readiness timeout.
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.ensureChain.catch(() => undefined);
    const current = this.current;
    this.current = null;
    if (current && !current.dead) {
      await stopChild(current.child);
    }
    // Idle-timer and unreachable-child stops must finish before the reaper
    // detaches: an un-awaited SIGTERM grace period would let the parent
    // exit while the detached child is still alive. Drained in a loop
    // because an in-flight proxyChat failure can add a NEW stop while the
    // previous batch is being awaited.
    while (this.pendingStops.size > 0) {
      // allSettled snapshots the set synchronously; the loop re-checks for
      // stops added while the previous batch was in flight.
      await Promise.allSettled(this.pendingStops);
    }
    this.detachReaper();
    this.logStream?.end();
    this.logStream = null;
  }

  private closed = false;

  private async ensureChild(
    model: string,
    adapterPath: string | null,
  ): Promise<LiveInferenceChild> {
    const key = `${model}\u0000${adapterPath ?? ""}`;
    const task = this.ensureChain.then(async () => {
      if (this.closed) {
        throw new Error("the local inference manager is shutting down");
      }
      const current = this.current;
      if (current?.key === key && !current.dead) {
        await current.ready;
        return current;
      }
      if (current && !current.dead) {
        // Different model/adapter requested: replace the child rather than
        // running two models side by side on a memory-constrained laptop.
        // Known trade-off: a response currently streaming from the old
        // child is cut short. Last-request-wins matches the single-user
        // laptop model this manager serves; queueing behind in-flight
        // bodies would let one long generation block a model switch.
        await stopChild(current.child);
      }
      this.current = null;
      const child = await this.spawnChild(key, model, adapterPath);
      this.current = child;
      await child.ready;
      return child;
    });
    this.ensureChain = task.catch(() => undefined);
    return task;
  }

  private async spawnChild(
    key: string,
    model: string,
    adapterPath: string | null,
  ): Promise<LiveInferenceChild> {
    const inference = this.backend.inference;
    if (!inference) {
      throw new Error(
        `the ${this.backend.id} backend does not support inference`,
      );
    }
    const port = await allocatePort();
    const spec = inference.buildServerSpec({
      model,
      adapterPath,
      host: "127.0.0.1",
      port,
      shimDir: this.shimDir,
    });
    const child = this.spawnImpl(spec.command, spec.argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.attachReaper(child);
    if (!this.logStream && !this.logTruncated) {
      // Tighten first: a legacy log that is ALREADY at the cap sets
      // `logTruncated` below and would otherwise keep its old (possibly
      // world-readable) mode forever. Best effort; a no-op on Windows.
      try {
        chmodSync(this.logFile, 0o600);
      } catch {
        // not created yet, or a platform without POSIX modes
      }
      // The log persists across restarts (append mode); seed the byte
      // budget from what is already on disk, otherwise every server
      // session could add another full cap's worth.
      try {
        this.logBytes = statSync(this.logFile).size;
      } catch {
        this.logBytes = 0;
      }
      if (this.logBytes >= INFERENCE_LOG_BYTE_CAP) {
        this.logTruncated = true;
      }
    }
    if (!this.logStream && !this.logTruncated) {
      const stream = createWriteStream(this.logFile, {
        flags: "a",
        // 0600 for the same reason as the job console log.
        mode: 0o600,
      });
      // Same rationale as the job store's console stream: an unhandled
      // 'error' on a diagnostics file must not crash the server process.
      stream.on("error", () => {
        if (this.logStream === stream) this.logStream = null;
      });
      this.logStream = stream;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      this.writeLog(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.writeLog(chunk);
    });

    const live: LiveInferenceChild = {
      key,
      child,
      port,
      ready: Promise.resolve(),
      dead: false,
    };
    child.on("close", () => {
      live.dead = true;
      if (this.current === live) this.current = null;
      this.detachReaperIfIdle(child);
    });
    child.on("error", () => {
      live.dead = true;
      if (this.current === live) this.current = null;
      this.detachReaperIfIdle(child);
    });

    live.ready = waitForPort({
      port,
      timeoutMs: this.readinessTimeoutMs,
      isDead: () => live.dead,
      isShuttingDown: () => this.closed,
    }).catch(async (error: unknown) => {
      // The child never became reachable; make sure it is gone and surface
      // the log path to the caller.
      live.dead = true;
      await stopChild(child);
      throw error;
    });
    return live;
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Belt on top of beginRequest()'s disarm: never shoot the child
      // while a request (or its streamed body) is still in flight.
      if (this.inFlight > 0) return;
      const current = this.current;
      this.current = null;
      if (current && !current.dead) {
        // Tracked so closeAll can await it: if shutdown starts during this
        // stop's SIGTERM grace period, the parent must not exit before the
        // escalation fires and the child is actually gone.
        this.trackStop(stopChild(current.child));
      }
    }, this.idleShutdownMs);
    this.idleTimer.unref();
  }

  /** In-flight child stops that closeAll must await before returning. */
  private readonly pendingStops = new Set<Promise<void>>();

  private trackStop(stop: Promise<void>): void {
    this.pendingStops.add(stop);
    void stop
      .catch(() => undefined)
      .finally(() => this.pendingStops.delete(stop));
  }

  // One refcounted process-exit reaper for the (single) inference child,
  // same pattern as the runner's training children.
  private reaperChild: ChildProcess | null = null;
  private readonly killOnExit = (): void => {
    const child = this.reaperChild;
    if (child) killGroup(child, "SIGKILL");
  };

  private attachReaper(child: ChildProcess): void {
    if (this.reaperChild === null) {
      process.on("exit", this.killOnExit);
    }
    this.reaperChild = child;
  }

  private detachReaperIfIdle(child: ChildProcess): void {
    if (this.reaperChild === child) this.detachReaper();
  }

  private detachReaper(): void {
    if (this.reaperChild !== null) {
      process.removeListener("exit", this.killOnExit);
      this.reaperChild = null;
    }
  }
}

/**
 * Translate the arkor chat body into an OpenAI `/v1/chat/completions`
 * payload. Adapter/baseModel selection happened before this call; the
 * unsupported-feature rejection happened in the route.
 */
function toOpenAiChatBody(
  model: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model,
    messages: body.messages,
    stream: body.stream ?? true,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.topP !== undefined) out.top_p = body.topP;
  if (body.maxTokens !== undefined) out.max_tokens = body.maxTokens;
  return out;
}

/**
 * Reserve an ephemeral loopback port by binding and releasing it.
 *
 * Known limitation (same-machine threat model): between the release and
 * the child's own bind, another LOCAL process could claim the port, and
 * the TCP readiness probe cannot authenticate the listener. `mlx_lm
 * server` offers no token/socket-inheritance mechanism to close this, so
 * the residual risk (a hostile local account intercepting prompts) is the
 * same one a user running `mlx_lm server` by hand accepts. Multi-user
 * shared machines should not run local inference until upstream grows an
 * authenticated hand-off.
 */
async function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Poll a TCP connect until the port accepts, the child dies, or timeout. */
async function waitForPort(args: {
  port: number;
  timeoutMs: number;
  isDead: () => boolean;
  /** Polled each round; lets shutdown abandon a minutes-long warmup wait. */
  isShuttingDown: () => boolean;
}): Promise<void> {
  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    if (args.isShuttingDown()) {
      throw new Error(
        "the local inference manager shut down before the server became ready",
      );
    }
    if (args.isDead()) {
      throw new Error("inference server exited before becoming ready");
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ port: args.port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `inference server did not become ready within ${String(args.timeoutMs)}ms`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, READINESS_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Resolve with `promise`, or reject as soon as `signal` aborts. The
 * underlying work is NOT torn down: for child spawn/readiness that is
 * exactly right (the warmed child serves the next request).
 */
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  // When the abort wins the race, the abandoned promise may still reject
  // later; mark that branch handled so it cannot become an unhandled
  // rejection.
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The listener is removed as soon as the promise settles so repeated
    // waits against a longer-lived signal cannot accumulate listeners.
    void promise
      .then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
          return undefined;
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      )
      .catch(() => undefined);
  });
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && typeof child.pid === "number") {
      process.kill(-child.pid, sig);
      return;
    }
  } catch {
    // fall through
  }
  try {
    child.kill(sig);
  } catch {
    // already exited
  }
}

/** SIGTERM, then SIGKILL after 5 s, resolving when the child is gone. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      killGroup(child, "SIGKILL");
    }, 5000);
    killTimer.unref();
    child.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    killGroup(child, "SIGTERM");
  });
}
