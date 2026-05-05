import { iterateEvents } from "@arkor/cloud-api-client";
import { CloudApiClient } from "./client";
import {
  defaultArkorCloudApiUrl,
  ensureCredentials,
  type Credentials,
} from "./credentials";
import { ensureProjectState } from "./projectState";
import {
  attachTrainerCallbackReplacer,
  attachTrainerEarlyStopper,
  attachTrainerInspection,
  type RequestEarlyStopOptions,
} from "./trainerInspection";
import type {
  CheckpointContext,
  InferArgs,
  JobConfig,
  Trainer,
  TrainerCallbacks,
  TrainerInput,
  TrainingJob,
  TrainingLogContext,
  TrainingResult,
} from "./types";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Internal runtime context. Not part of the public API surface — exposed only
 * for tests and advanced power-user scenarios that need to inject a mock
 * `fetch` or override the working directory.
 *
 * @internal
 */
export interface TrainerInternalContext {
  baseUrl?: string;
  credentials?: Credentials;
  cwd?: string;
  /**
   * Initial reconnect back-off in milliseconds. Subsequent failures use
   * exponential backoff (×2 each time) capped at `maxReconnectDelayMs`.
   * Defaults to 1000.
   */
  reconnectDelayMs?: number;
  /**
   * Cap for the exponential backoff delay in milliseconds. Defaults to
   * 60_000 (60 s) so a multi-hour outage doesn't escalate beyond the
   * recovery window the cloud-api is optimised for.
   */
  maxReconnectDelayMs?: number;
  /**
   * Maximum number of consecutive failed reconnect attempts before
   * `wait()` rejects with the last error. Counter resets every time the
   * stream yields at least one event (so a single mid-stream blip doesn't
   * count against a long-running job). Undefined means unlimited.
   */
  maxReconnectAttempts?: number;
}

interface StreamEventBase {
  type: string;
  jobId: string;
  timestamp: string;
}

type StreamEvent =
  | (StreamEventBase & { type: "training.started"; metadata?: unknown })
  | (StreamEventBase & {
      type: "training.log";
      step: number;
      loss?: number | null;
      evalLoss?: number | null;
      learningRate?: number | null;
      epoch?: number | null;
      samplesPerSecond?: number | null;
    })
  | (StreamEventBase & {
      type: "checkpoint.saved";
      step: number;
      artifacts?: unknown[];
    })
  | (StreamEventBase & {
      type: "training.completed";
      metrics?: unknown;
      artifacts?: unknown[];
    })
  | (StreamEventBase & { type: "training.failed"; error: string; step?: number });

function buildJobConfig(input: TrainerInput): JobConfig {
  const config: JobConfig = {
    model: input.model,
    datasetSource: input.dataset,
  };
  if (input.lora) {
    config.loraR = input.lora.r;
    config.loraAlpha = input.lora.alpha;
    if (input.lora.maxLength !== undefined) config.maxLength = input.lora.maxLength;
    if (input.lora.loadIn4bit !== undefined) config.loadIn4bit = input.lora.loadIn4bit;
  }
  if (input.maxSteps !== undefined) config.maxSteps = input.maxSteps;
  if (input.numTrainEpochs !== undefined) config.numTrainEpochs = input.numTrainEpochs;
  if (input.learningRate !== undefined) config.learningRate = input.learningRate;
  if (input.batchSize !== undefined) config.batchSize = input.batchSize;
  if (input.optim !== undefined) config.optim = input.optim;
  if (input.lrSchedulerType !== undefined) config.lrSchedulerType = input.lrSchedulerType;
  if (input.weightDecay !== undefined) config.weightDecay = input.weightDecay;
  if (input.warmupSteps !== undefined) config.warmupSteps = input.warmupSteps;
  if (input.loggingSteps !== undefined) config.loggingSteps = input.loggingSteps;
  if (input.saveSteps !== undefined) config.saveSteps = input.saveSteps;
  if (input.evalSteps !== undefined) config.evalSteps = input.evalSteps;
  if (input.trainOnResponsesOnly !== undefined)
    config.trainOnResponsesOnly = input.trainOnResponsesOnly;
  if (input.datasetFormat !== undefined) config.datasetFormat = input.datasetFormat;
  if (input.datasetSplit !== undefined) config.datasetSplit = input.datasetSplit;
  if (input.dryRun !== undefined) config.dryRun = input.dryRun;
  return config;
}

/**
 * Build a `Trainer` bound to the user's configuration.
 *
 * Public signature: `createTrainer(input)` — runtime options like
 * `baseUrl` / `credentials` / `cwd` come from the environment and `.arkor/`
 * state, never from user code. The optional second argument is reserved for
 * tests and advanced overrides.
 *
 * `.start()` submits the job and `.wait()` opens an SSE stream
 * (`GET /v1/jobs/:id/events/stream`), dispatching callbacks as events arrive.
 * `onCheckpoint` receives an `infer` helper bound to the checkpoint's adapter
 * for mid-training evaluation.
 */
export function createTrainer(
  input: TrainerInput,
  /** @internal */
  context: TrainerInternalContext = {},
): Trainer {
  const baseUrl = context.baseUrl ?? defaultArkorCloudApiUrl();
  const initialReconnectDelayMs = context.reconnectDelayMs ?? 1000;
  const maxReconnectDelayMs = context.maxReconnectDelayMs ?? 60_000;
  const maxReconnectAttempts = context.maxReconnectAttempts;
  const cwd = context.cwd ?? process.cwd();
  const config = buildJobConfig(input);

  let startedJob: TrainingJob | null = null;
  let scope: { orgSlug: string; projectSlug: string } | null = null;
  let clientPromise: Promise<CloudApiClient> | null = null;

  // Mutable callbacks slot. Each `dispatch()` invocation reads this
  // fresh, so the rotation triggered by the
  // `Symbol.for("arkor.trainer.replaceCallbacks")` brand
  // (`replaceTrainerCallbacks` in `core/trainerInspection.ts`) takes
  // effect on the next event. Events already mid-await keep their
  // old reference until they resolve, which matches the "replace,
  // don't interrupt" contract. Public `Trainer` deliberately doesn't
  // expose this — it's a dev-only HMR primitive driven by the
  // SIGUSR2 path in `core/runnerSignals.ts`.
  let currentCallbacks: Partial<TrainerCallbacks> = input.callbacks ?? {};

  // Early-stop state. `requestEarlyStop()` arms the latch; the next
  // `checkpoint.saved` dispatch (or the timeout, whichever fires first)
  // calls cancel() and resolves the deferred. Idempotent across repeat
  // calls — they share the same deferred.
  const DEFAULT_EARLY_STOP_TIMEOUT_MS = 5 * 60 * 1000;
  let earlyStopDeferred: {
    promise: Promise<void>;
    resolve: () => void;
    timer: NodeJS.Timeout | null;
  } | null = null;
  let earlyStopRequested = false;

  async function getClient(): Promise<CloudApiClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const credentials = context.credentials ?? (await ensureCredentials());
        return new CloudApiClient({ baseUrl, credentials });
      })();
    }
    return clientPromise;
  }

  async function resolveProjectState(client: CloudApiClient) {
    const credentials = context.credentials ?? (await ensureCredentials());
    return ensureProjectState({ cwd, client, credentials });
  }

  /**
   * Exponential backoff with ±25% jitter, capped at `maxReconnectDelayMs`.
   * The jitter spreads reconnect storms when a cloud-api recovers and
   * many SDK clients retry at once.
   *
   * The final value is clamped at `maxReconnectDelayMs` because jitter
   * sits *outside* the exponential clamp — without the outer clamp, a
   * long outage where `exp` already hit the cap could wait up to 1.25 ×
   * the documented cap when `Math.random()` lands near 1.
   */
  function nextReconnectDelay(attempt: number): number {
    const exp = Math.min(
      initialReconnectDelayMs * 2 ** attempt,
      maxReconnectDelayMs,
    );
    const jitter = exp * (Math.random() * 0.5 - 0.25);
    return Math.max(0, Math.min(maxReconnectDelayMs, exp + jitter));
  }

  async function delay(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function dispatch(
    event: StreamEvent,
    terminalResult: { status: TrainingJob["status"]; artifacts: unknown[] } | null,
  ): Promise<{ terminal: boolean; artifacts: unknown[] }> {
    if (!startedJob || !scope) {
      throw new Error("Trainer is in an inconsistent state");
    }
    const client = await getClient();
    // Read once per dispatch so a `replaceCallbacks` between events takes
    // effect on the next dispatch, but doesn't change identity inside a
    // single in-flight handler.
    const callbacks = currentCallbacks;

    switch (event.type) {
      case "training.started": {
        startedJob = { ...startedJob, status: "running", startedAt: event.timestamp };
        await callbacks.onStarted?.({ job: startedJob });
        return { terminal: false, artifacts: terminalResult?.artifacts ?? [] };
      }
      case "training.log": {
        const ctx: TrainingLogContext = {
          step: event.step,
          loss: event.loss ?? null,
          evalLoss: event.evalLoss ?? null,
          learningRate: event.learningRate ?? null,
          epoch: event.epoch ?? null,
          samplesPerSecond: event.samplesPerSecond ?? null,
          job: startedJob,
        };
        await callbacks.onLog?.(ctx);
        return { terminal: false, artifacts: terminalResult?.artifacts ?? [] };
      }
      case "checkpoint.saved": {
        const adapter = {
          kind: "checkpoint" as const,
          jobId: startedJob.id,
          step: event.step,
        };
        const infer = (args: InferArgs): Promise<Response> =>
          client.chat({
            scope: scope!,
            body: {
              messages: args.messages,
              adapter,
              temperature: args.temperature,
              topP: args.topP,
              maxTokens: args.maxTokens,
              stream: args.stream ?? true,
            },
            signal: args.signal,
          });
        const ctx: CheckpointContext = {
          step: event.step,
          adapter,
          job: startedJob,
          infer,
          artifacts: event.artifacts,
        };
        await callbacks.onCheckpoint?.(ctx);
        // Early-stop latch: a checkpoint just landed, so the in-flight work
        // is durable. Cancel the cloud job and end `wait()` cleanly.
        if (earlyStopRequested && earlyStopDeferred) {
          // Best-effort `cancel()` — swallow throws so the deferred
          // *always* resolves and the SIGTERM handler waiting on
          // `requestEarlyStop()` can exit. Letting an error propagate
          // here would leave the deferred pending and the runner
          // process hung on shutdown; the local `startedJob.status`
          // is set to `cancelled` regardless so subsequent
          // `requestEarlyStop` calls see the terminal-status
          // short-circuit. The cookbook already calls `cancel()`
          // best-effort, so users tolerating a transient cloud-api
          // failure here matches the documented contract.
          try {
            await trainer.cancel();
          } catch {
            // intentionally ignored — see comment above.
          }
          // Reflect the cancellation locally so `wait()`'s resolved
          // `TrainingResult.job.status` is a terminal status (per the
          // documented contract). Without this update the result would
          // surface as `status: "running"`, and a subsequent
          // `requestEarlyStop` would not see the
          // `TERMINAL_STATUSES.has(...)` short-circuit it relies on.
          startedJob = {
            ...startedJob,
            status: "cancelled",
            completedAt: event.timestamp,
          };
          if (earlyStopDeferred.timer) clearTimeout(earlyStopDeferred.timer);
          earlyStopDeferred.resolve();
          earlyStopDeferred = null;
          earlyStopRequested = false;
          return { terminal: true, artifacts: terminalResult?.artifacts ?? [] };
        }
        return { terminal: false, artifacts: terminalResult?.artifacts ?? [] };
      }
      case "training.completed": {
        startedJob = {
          ...startedJob,
          status: "completed",
          completedAt: event.timestamp,
        };
        const artifacts = (event.artifacts ?? []) as unknown[];
        await callbacks.onCompleted?.({ job: startedJob, artifacts });
        return { terminal: true, artifacts };
      }
      case "training.failed": {
        startedJob = {
          ...startedJob,
          status: "failed",
          error: event.error,
          completedAt: event.timestamp,
        };
        await callbacks.onFailed?.({ job: startedJob, error: event.error });
        return { terminal: true, artifacts: [] };
      }
    }
  }

  const trainer: Trainer = {
    name: input.name,

    async start() {
      if (startedJob) return { jobId: startedJob.id };
      const client = await getClient();
      const state = await resolveProjectState(client);
      scope = { orgSlug: state.orgSlug, projectSlug: state.projectSlug };

      const { job } = await client.createJob({
        orgSlug: state.orgSlug,
        projectSlug: state.projectSlug,
        name: input.name,
        config,
      });
      startedJob = job;
      return { jobId: job.id };
    },

    async wait(): Promise<TrainingResult> {
      if (!startedJob) await trainer.start();
      if (!startedJob || !scope) {
        throw new Error("Trainer is in an inconsistent state after start()");
      }
      const client = await getClient();
      const { abortSignal } = input;

      let lastEventId: string | undefined;
      let artifacts: unknown[] = [];
      let terminal = false;
      // Consecutive failed reconnects. Reset every time the stream yields
      // at least one event so a long-running job that briefly drops
      // doesn't burn through `maxReconnectAttempts` over its lifetime.
      let attempt = 0;

      const handleFailure = async (err: unknown): Promise<void> => {
        if (abortSignal?.aborted) throw err;
        if (
          maxReconnectAttempts !== undefined &&
          attempt >= maxReconnectAttempts
        ) {
          throw new Error(
            `Trainer SSE stream failed ${attempt + 1} consecutive times; giving up.`,
            { cause: err },
          );
        }
        await delay(nextReconnectDelay(attempt), abortSignal);
        attempt++;
      };

      while (!terminal) {
        let response: Response;
        try {
          response = await client.openEventStream(startedJob.id, scope, {
            lastEventId,
            signal: abortSignal,
          });
        } catch (err) {
          await handleFailure(err);
          continue;
        }

        let receivedAny = false;
        try {
          for await (const sse of iterateEvents(response)) {
            // Any frame from the server (including pings) means we're
            // connected and making progress — reset the failure counter
            // so subsequent transient blips get the full retry budget.
            receivedAny = true;
            attempt = 0;
            if (sse.id) lastEventId = sse.id;
            if (sse.event === "ping") continue;
            if (sse.event === "end") {
              terminal = true;
              break;
            }
            let parsed: StreamEvent;
            try {
              parsed = JSON.parse(sse.data) as StreamEvent;
            } catch {
              continue; // malformed event; skip
            }
            const result = await dispatch(parsed, null);
            if (result.terminal) {
              artifacts = result.artifacts;
              terminal = true;
              break;
            }
          }
        } catch (err) {
          await handleFailure(err);
          continue;
        }

        if (terminal) break;

        if (receivedAny) {
          // Stream had real activity then closed cleanly. Not a failure —
          // reconnect with Last-Event-ID at the base delay (no exponential
          // backoff, no counter increment).
          await delay(initialReconnectDelayMs, abortSignal);
        } else {
          // 200 OK but the stream EOF'd without yielding any frame. This
          // is the signature of a misconfigured proxy / LB that accepts
          // the connection and immediately drops it. Count it toward
          // `maxReconnectAttempts` so we don't loop forever at the base
          // delay against the same broken intermediary.
          await handleFailure(
            new Error("SSE stream closed without emitting any frame"),
          );
        }
      }

      return { job: startedJob, artifacts };
    },

    async cancel(): Promise<void> {
      if (!startedJob || !scope) return;
      const client = await getClient();
      await client.cancelJob(startedJob.id, scope);
    },
  };

  /**
   * Internal "stop after next checkpoint" entry point. Hidden behind a
   * `Symbol.for` brand so the runner subprocess's SIGTERM handler (in
   * `runnerSignals.ts`) can drive a graceful early-stop without us
   * exposing the operation on the public `Trainer` interface. User code
   * that wants the same semantics should compose `abortSignal` +
   * `cancel()` per `docs/cookbook/early-stopping.mdx`.
   */
  async function requestEarlyStop(
    opts: RequestEarlyStopOptions = {},
  ): Promise<void> {
    // Nothing in flight: cleanup any prior latch and resolve.
    if (!startedJob || !scope || TERMINAL_STATUSES.has(startedJob.status)) {
      if (earlyStopDeferred) {
        if (earlyStopDeferred.timer) clearTimeout(earlyStopDeferred.timer);
        earlyStopDeferred.resolve();
        earlyStopDeferred = null;
      }
      earlyStopRequested = false;
      return;
    }
    // Idempotent: a second call piggybacks on the first.
    if (earlyStopDeferred) return earlyStopDeferred.promise;

    earlyStopRequested = true;
    let resolveFn!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EARLY_STOP_TIMEOUT_MS;
    const timer = setTimeout(() => {
      // Timed out waiting for a checkpoint — fall back to immediate cancel.
      // Capture the active deferred reference: by the time the cancel POST
      // resolves, the checkpoint branch may have nulled out the shared
      // slot, but this fallback path still owns the deferred it created.
      const active = earlyStopDeferred;
      trainer
        .cancel()
        .catch(() => {})
        .finally(() => {
          // Mirror the checkpoint-triggered early-stop branch: reset
          // the latch and reflect the cancellation locally so a
          // second `requestEarlyStop()` call is a no-op (instead of
          // re-arming a fresh timer + re-issuing cancel) and so
          // `wait()`'s eventual resolution exposes a terminal status.
          // Without this, a long-lived trainer left in
          // `earlyStopRequested = true` would re-cancel on every
          // future checkpoint event for the rest of its lifetime.
          earlyStopRequested = false;
          if (startedJob && !TERMINAL_STATUSES.has(startedJob.status)) {
            startedJob = {
              ...startedJob,
              status: "cancelled",
              completedAt: new Date().toISOString(),
            };
          }
          if (active) active.resolve();
          if (earlyStopDeferred === active) earlyStopDeferred = null;
        });
    }, timeoutMs);
    // `Timer.unref` keeps the early-stop timer from blocking process exit
    // when the host runtime finishes for unrelated reasons.
    timer.unref?.();
    earlyStopDeferred = { promise, resolve: resolveFn, timer };
    return promise;
  }

  // Brand the trainer with the HMR control surface so the Studio server
  // can (a) hash the cloud-side config to decide between hot-swap and
  // restart, (b) atomically swap the callbacks cell from the runner
  // subprocess on SIGUSR2, and (c) drive a graceful "stop after the
  // next checkpoint" on SIGTERM. All three brands live behind
  // `Symbol.for` keys so they don't appear on the public `Trainer`
  // interface — see `trainerInspection.ts` for the rationale.
  attachTrainerInspection(trainer, () => ({
    name: input.name,
    config,
    callbacks: currentCallbacks,
  }));
  attachTrainerCallbackReplacer(trainer, (callbacks) => {
    currentCallbacks = callbacks ?? {};
  });
  attachTrainerEarlyStopper(trainer, requestEarlyStop);

  return trainer;
}
