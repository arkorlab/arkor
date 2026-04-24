import { iterateEvents } from "@arkor/cloud-api-client";
import { CloudApiClient, CloudApiError } from "./client";
import {
  defaultArkorCloudApiUrl,
  ensureCredentials,
  type Credentials,
} from "./credentials";
import { readState, writeState } from "./state";
import type {
  ArkorProjectState,
  CheckpointContext,
  InferArgs,
  Trainer,
  TrainerOptions,
  TrainingJob,
  TrainingLogContext,
  TrainingResult,
} from "./types";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface CreateTrainerContext {
  /** Override the resolved cloud-api base URL (defaults to env / localhost:3003). */
  baseUrl?: string;
  /** Override credentials (primarily for tests). */
  credentials?: Credentials;
  /** Override the project working directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Reconnect back-off on stream drops (ms). Defaults to 1000. */
  reconnectDelayMs?: number;
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

/**
 * Build a `Trainer` bound to the user's configuration.
 *
 * `.start()` submits the job and `.wait()` opens an SSE stream
 * (`GET /v1/jobs/:id/events/stream`), dispatching callbacks as events
 * arrive. `onCheckpoint` receives an `infer` helper bound to the
 * checkpoint's adapter for mid-training evaluation.
 */
export function createTrainer(
  options: TrainerOptions,
  context: CreateTrainerContext = {},
): Trainer {
  const baseUrl = context.baseUrl ?? defaultArkorCloudApiUrl();
  const reconnectDelayMs = context.reconnectDelayMs ?? 1000;
  const cwd = context.cwd ?? process.cwd();

  let startedJob: TrainingJob | null = null;
  let scope: { orgSlug: string; projectSlug: string } | null = null;
  let clientPromise: Promise<CloudApiClient> | null = null;

  async function getClient(): Promise<CloudApiClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const credentials = context.credentials ?? (await ensureCredentials());
        return new CloudApiClient({ baseUrl, credentials });
      })();
    }
    return clientPromise;
  }

  async function ensureProjectState(
    client: CloudApiClient,
  ): Promise<ArkorProjectState> {
    const existing = await readState(cwd);
    if (existing) return existing;

    const credentials = context.credentials ?? (await ensureCredentials());
    if (credentials.mode !== "anon") {
      throw new Error(
        "No .arkor/state.json found. Run `arkor init` to scaffold the project, or create .arkor/state.json manually with { orgSlug, projectSlug, projectId }.",
      );
    }
    const orgSlug = credentials.orgSlug;

    const baseName = cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
    const projectSlug = baseName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";

    let project: { id: string; slug: string };
    try {
      const res = await client.createProject({
        orgSlug,
        name: baseName,
        slug: projectSlug,
      });
      project = res.project;
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 409) {
        const { projects } = await client.listProjects(orgSlug);
        const found = projects.find((p) => p.slug === projectSlug);
        if (!found) throw err;
        project = found;
      } else {
        throw err;
      }
    }

    const state: ArkorProjectState = {
      orgSlug,
      projectSlug: project.slug,
      projectId: project.id,
    };
    await writeState(state, cwd);
    return state;
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
    const callbacks = options.callbacks ?? {};

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
    async start() {
      if (startedJob) return { jobId: startedJob.id };
      const client = await getClient();
      const state = await ensureProjectState(client);
      scope = { orgSlug: state.orgSlug, projectSlug: state.projectSlug };

      const { job } = await client.createJob({
        orgSlug: state.orgSlug,
        projectSlug: state.projectSlug,
        name: options.name,
        config: options.config,
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
      const { abortSignal } = options;

      let lastEventId: string | undefined;
      let artifacts: unknown[] = [];
      let terminal = false;

      while (!terminal) {
        let response: Response;
        try {
          response = await client.openEventStream(startedJob.id, scope, {
            lastEventId,
            signal: abortSignal,
          });
        } catch (err) {
          if (abortSignal?.aborted) throw err;
          // Transient network error — back off and retry.
          await delay(reconnectDelayMs, abortSignal);
          continue;
        }

        try {
          for await (const sse of iterateEvents(response)) {
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
          if (abortSignal?.aborted) throw err;
          // Stream closed unexpectedly — back off and resume with Last-Event-ID.
          await delay(reconnectDelayMs, abortSignal);
          continue;
        }

        if (!terminal) {
          // Stream closed cleanly but we haven't seen a terminal event yet.
          // Reconnect with Last-Event-ID to drain the queue.
          await delay(reconnectDelayMs, abortSignal);
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

  return trainer;
}
