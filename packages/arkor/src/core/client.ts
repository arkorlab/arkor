import {
  createClient as createArkorRpc,
  parseErrorBody,
  type ArkorClient,
} from "@arkor/cloud-api-client";
import type { z } from "zod";
import type { Credentials } from "./credentials";
import type {
  CreateDeploymentInput,
  CreateDeploymentKeyInput,
  CreateDeploymentKeyResult,
  DeploymentDto,
  DeploymentKeyDto,
  DeploymentScope,
  UpdateDeploymentInput,
} from "./deployments";
import { recordDeprecation, tapDeprecation } from "./deprecation";
import {
  createDeploymentKeyResponseSchema,
  createDeploymentResponseSchema,
  createJobResponseSchema,
  createProjectResponseSchema,
  getDeploymentResponseSchema,
  jobDetailResponseSchema,
  listDeploymentKeysResponseSchema,
  listDeploymentsResponseSchema,
  listProjectsResponseSchema,
  updateDeploymentResponseSchema,
} from "./schemas";
import type {
  ChatMessage,
  JobConfig,
  ResponseFormat,
  StructuredOutputs,
  ToolChoice,
  ToolDefinition,
  TrainingJob,
} from "./types";
import { formatSdkUpgradeError } from "./upgrade-hint";
import { SDK_VERSION } from "./version";

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
    throw await buildCloudApiError(res);
  }
  return schema.parse(await res.json());
}

/**
 * Build a `CloudApiError` from a non-ok Response, inlining the cloud-api
 * gate's upgrade hint when the status is 426.
 */
async function buildCloudApiError(res: Response): Promise<CloudApiError> {
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON — fall through
  }
  // 426 always carries the upgrade hint, even for malformed bodies, so
  // callers don't have to special-case the gate's response shape.
  if (res.status === 426) {
    return new CloudApiError(res.status, formatSdkUpgradeError(parsed));
  }
  const fields = parseErrorBody(parsed);
  // Use `||` (not `??`) so an empty-string body falls through to the
  // generic `cloud-api <status>` instead of becoming an empty message.
  const message = fields.error || text || `cloud-api ${res.status}`;
  return new CloudApiError(res.status, message);
}

export interface CloudApiClientOptions {
  baseUrl: string;
  credentials: Credentials;
  fetch?: typeof fetch;
  /**
   * Override the per-response deprecation callback. Defaults to the
   * SDK-global `recordDeprecation`, which the CLI flushes once at the
   * end of `main()`. Studio overrides this so it can capture the
   * notice per-request and re-emit it as `Deprecation` / `Warning` /
   * `Sunset` headers on the proxy response, matching the passthrough
   * behavior of `/api/jobs` and friends.
   */
  onDeprecation?: (notice: import("./deprecation").DeprecationNotice) => void;
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
      clientVersion: SDK_VERSION,
      // The wrapper around the deprecation callback works around a bug
      // in `@arkor/cloud-api-client` (alpha.2): the upstream runtime
      // probes the handler's return value with
      // `result !== null && typeof result.then === "function"`, then
      // wraps `result.catch(...)`. A `void` return makes
      // `typeof undefined.then` throw inside `try`, and the surrounding
      // catch logs `[@arkor/cloud-api-client] onDeprecation handler
      // threw; ignoring:` on every deprecated response — even though
      // the user handler ran fine. Returning `null` short-circuits the
      // left side of the `&&`, so the `.then` access never runs and
      // the spurious log goes away. Same pattern is mirrored in
      // `studio/server.ts`. Drop this once an alpha ships the
      // upstream fix.
      onDeprecation: (notice) => {
        (options.onDeprecation ?? recordDeprecation)(notice);
        return null;
      },
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
      throw await buildCloudApiError(res);
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
          "X-Arkor-Client": `arkor/${SDK_VERSION}`,
          ...(options.lastEventId
            ? { "Last-Event-ID": options.lastEventId }
            : {}),
        },
        signal: options.signal,
      },
    );
    tapDeprecation(res, SDK_VERSION);
    if (!res.ok) {
      throw await buildCloudApiError(res);
    }
    return res;
  }

  // ---------------------------------------------------------------------
  // Deployments (`/v1/endpoints/*`)
  //
  // Routed through the typed Hono RPC client so the cloud API's
  // discriminated `target` shape, `authMode` enum, and 204 statuses are
  // checked at compile time. Migrated from raw fetch in
  // `@arkor/cloud-api-client@0.0.1-alpha.2`, which was the first published
  // version exposing these routes' types.
  // ---------------------------------------------------------------------

  async listDeployments(
    scope: DeploymentScope,
  ): Promise<{ deployments: DeploymentDto[] }> {
    const res = await this.rpc.v1.endpoints.$get({ query: scope });
    const data = await decode(res, listDeploymentsResponseSchema);
    return data as unknown as { deployments: DeploymentDto[] };
  }

  async getDeployment(
    id: string,
    scope: DeploymentScope,
  ): Promise<{ deployment: DeploymentDto }> {
    const res = await this.rpc.v1.endpoints[":id"].$get({
      param: { id },
      query: scope,
    });
    const data = await decode(res, getDeploymentResponseSchema);
    return data as unknown as { deployment: DeploymentDto };
  }

  async createDeployment(
    scope: DeploymentScope,
    input: CreateDeploymentInput,
  ): Promise<{ deployment: DeploymentDto }> {
    const res = await this.rpc.v1.endpoints.$post({
      query: scope,
      json: input,
    });
    const data = await decode(res, createDeploymentResponseSchema);
    return data as unknown as { deployment: DeploymentDto };
  }

  async updateDeployment(
    id: string,
    scope: DeploymentScope,
    input: UpdateDeploymentInput,
  ): Promise<{ deployment: DeploymentDto }> {
    const res = await this.rpc.v1.endpoints[":id"].$patch({
      param: { id },
      query: scope,
      json: input,
    });
    const data = await decode(res, updateDeploymentResponseSchema);
    return data as unknown as { deployment: DeploymentDto };
  }

  async deleteDeployment(id: string, scope: DeploymentScope): Promise<void> {
    const res = await this.rpc.v1.endpoints[":id"].$delete({
      param: { id },
      query: scope,
    });
    if (!res.ok) {
      throw await buildCloudApiError(res);
    }
  }

  async listDeploymentKeys(
    id: string,
    scope: DeploymentScope,
  ): Promise<{ keys: DeploymentKeyDto[] }> {
    const res = await this.rpc.v1.endpoints[":id"].keys.$get({
      param: { id },
      query: scope,
    });
    const data = await decode(res, listDeploymentKeysResponseSchema);
    return data as unknown as { keys: DeploymentKeyDto[] };
  }

  async createDeploymentKey(
    id: string,
    scope: DeploymentScope,
    input: CreateDeploymentKeyInput,
  ): Promise<{ key: CreateDeploymentKeyResult }> {
    const res = await this.rpc.v1.endpoints[":id"].keys.$post({
      param: { id },
      query: scope,
      json: input,
    });
    const data = await decode(res, createDeploymentKeyResponseSchema);
    return data as unknown as { key: CreateDeploymentKeyResult };
  }

  async revokeDeploymentKey(
    id: string,
    keyId: string,
    scope: DeploymentScope,
  ): Promise<void> {
    const res = await this.rpc.v1.endpoints[":id"].keys[":keyId"].$delete({
      param: { id, keyId },
      query: scope,
    });
    if (!res.ok) {
      throw await buildCloudApiError(res);
    }
  }

  /**
   * POST to `/v1/inference/chat`. Returns the raw Response so the caller can
   * stream the SSE body (or `.text()` it when streaming is off).
   */
  async chat(input: {
    scope: { orgSlug: string; projectSlug: string };
    body: {
      messages: ChatMessage[];
      adapter?: { kind: "final" | "checkpoint"; jobId: string; step?: number };
      baseModel?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      stream?: boolean;
      // Function calling + structured outputs. Forwarded verbatim — the
      // cloud-api inference route spreads the body into its proxy, so any
      // field declared on `chatInferenceRequestSchema` flows through.
      tools?: ToolDefinition[];
      toolChoice?: ToolChoice;
      responseFormat?: ResponseFormat;
      structuredOutputs?: StructuredOutputs;
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
          "X-Arkor-Client": `arkor/${SDK_VERSION}`,
        },
        body: JSON.stringify(input.body),
        signal: input.signal,
      },
    );
    tapDeprecation(res, SDK_VERSION);
    if (!res.ok) {
      throw await buildCloudApiError(res);
    }
    return res;
  }
}
