import {
  createClient as createArkorRpc,
  type ArkorClient,
} from "@arkor/cloud-api-client";
import type { z } from "zod";
import type { Credentials } from "./credentials";
import {
  createJobResponseSchema,
  createProjectResponseSchema,
  jobDetailResponseSchema,
  listProjectsResponseSchema,
} from "./schemas";
import type { JobConfig, TrainingJob } from "./types";

export class CloudApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CloudApiError";
  }
}

function tokenFromCredentials(c: Credentials): string {
  return c.mode === "anon" ? c.token : c.accessToken;
}

async function decode<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      // ignore parse errors; fall back to raw text
    }
    throw new CloudApiError(res.status, message || `cloud-api ${res.status}`);
  }
  return schema.parse(await res.json());
}

export interface CloudApiClientOptions {
  baseUrl: string;
  credentials: Credentials;
  fetch?: typeof fetch;
}

export class CloudApiClient {
  private readonly rpc: ArkorClient;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  constructor(options: CloudApiClientOptions) {
    this.token = tokenFromCredentials(options.credentials);
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.rpc = createArkorRpc({
      baseUrl: this.baseUrl,
      token: () => this.token,
      fetch: options.fetch,
    });
  }

  private authHeader(): string {
    return `Bearer ${this.token}`;
  }

  async listProjects(orgSlug: string) {
    const res = await this.rpc.v1.projects.$get({ query: { orgSlug } });
    return decode(res, listProjectsResponseSchema);
  }

  async createProject(input: {
    orgSlug: string;
    name: string;
    slug: string;
  }) {
    const res = await this.rpc.v1.projects.$post({
      query: { orgSlug: input.orgSlug },
      json: { name: input.name, slug: input.slug },
    });
    return decode(res, createProjectResponseSchema);
  }

  async createJob(input: {
    orgSlug: string;
    projectSlug: string;
    name: string;
    config: JobConfig;
  }): Promise<{ job: TrainingJob }> {
    // The server's Zod schema for job config is `looseObject` — any object
    // with a `model` + `datasetSource` passes. The Hono RPC input type is
    // inferred from that schema, so we cast through `unknown` to satisfy
    // the structural mismatch on `datasetSource`'s discriminated shape.
    const res = await this.rpc.v1.jobs.$post({
      query: { orgSlug: input.orgSlug, projectSlug: input.projectSlug },
      json: {
        name: input.name,
        config: input.config as unknown as Parameters<
          typeof this.rpc.v1.jobs.$post
        >[0]["json"]["config"],
      },
    });
    const data = await decode(res, createJobResponseSchema);
    return data as unknown as { job: TrainingJob };
  }

  async getJob(
    jobId: string,
    scope: { orgSlug: string; projectSlug: string },
  ): Promise<{ job: TrainingJob; events?: unknown[] }> {
    const res = await this.rpc.v1.jobs[":id"].$get({
      param: { id: jobId },
      query: scope,
    });
    const data = await decode(res, jobDetailResponseSchema);
    return data as unknown as { job: TrainingJob; events?: unknown[] };
  }

  async cancelJob(
    jobId: string,
    scope: { orgSlug: string; projectSlug: string },
  ): Promise<void> {
    const res = await this.rpc.v1.jobs[":id"].cancel.$post({
      param: { id: jobId },
      query: scope,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloudApiError(res.status, text || `cloud-api ${res.status}`);
    }
  }

  /**
   * Open the SSE event stream for a job. Returns the raw Response so the
   * caller can pass the body straight to `iterateEvents`. When `lastEventId`
   * is supplied it is forwarded via `Last-Event-ID` for resume.
   */
  async openEventStream(
    jobId: string,
    scope: { orgSlug: string; projectSlug: string },
    options: { lastEventId?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const qs = `orgSlug=${encodeURIComponent(scope.orgSlug)}&projectSlug=${encodeURIComponent(scope.projectSlug)}`;
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/events/stream?${qs}`,
      {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: this.authHeader(),
          ...(options.lastEventId
            ? { "Last-Event-ID": options.lastEventId }
            : {}),
        },
        signal: options.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloudApiError(res.status, text || `cloud-api ${res.status}`);
    }
    return res;
  }

  /**
   * POST to `/v1/inference/chat`. Returns the raw Response so the caller can
   * stream the SSE body (or `.text()` it when streaming is off).
   */
  async chat(input: {
    scope: { orgSlug: string; projectSlug: string };
    body: {
      messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
      adapter?: { kind: "final" | "checkpoint"; jobId: string; step?: number };
      baseModel?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      stream?: boolean;
    };
    signal?: AbortSignal;
  }): Promise<Response> {
    const qs = `orgSlug=${encodeURIComponent(input.scope.orgSlug)}&projectSlug=${encodeURIComponent(input.scope.projectSlug)}`;
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/inference/chat?${qs}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader(),
        },
        body: JSON.stringify(input.body),
        signal: input.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloudApiError(res.status, text || `cloud-api ${res.status}`);
    }
    return res;
  }
}
