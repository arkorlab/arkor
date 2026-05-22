import { describe, it, expect } from "vitest";
import { CloudApiClient, CloudApiError } from "./client";
import type { Credentials } from "./credentials";
import type { CreateDeploymentInput, DeploymentDto } from "./deployments";

const BASE_URL = "https://cloud-api.test";

const TEST_CREDENTIALS: Credentials = {
  mode: "anon",
  token: "anon-test-token",
  anonymousId: "anon-1",
  arkorCloudApiUrl: BASE_URL,
  orgSlug: "anon-org",
};

type FetchCall = { url: string; init: RequestInit };

/**
 * Drop-in replacement for `globalThis.fetch` that records every call and
 * dispatches to the first matching handler. Each test composes its own set
 * of (matcher, response) pairs so assertions can interrogate request shape
 * without touching the real network.
 */
function recordingFetch(
  responders: Array<{
    match: (url: string, init: RequestInit) => boolean;
    respond: () => Response;
  }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    const ri = init ?? {};
    calls.push({ url, init: ri });
    const handler = responders.find((r) => r.match(url, ri));
    if (!handler) {
      return new Response(JSON.stringify({ error: "no handler" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return handler.respond();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function clientWith(fetchImpl: typeof fetch): CloudApiClient {
  return new CloudApiClient({
    baseUrl: BASE_URL,
    credentials: TEST_CREDENTIALS,
    fetch: fetchImpl,
  });
}

const SAMPLE_DEPLOYMENT: DeploymentDto = {
  id: "00000000-0000-4000-8000-000000000010",
  slug: "myllama",
  orgId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  target: { kind: "base_model", baseModel: "meta-llama/Llama-2-7b-hf" },
  authMode: "fixed_api_key",
  urlFormat: "openai_compat",
  enabled: true,
  customDomain: null,
  runRetentionMode: "days",
  runRetentionDays: 7,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};

const SCOPE = { orgSlug: "myorg", projectSlug: "myproj" };

describe("CloudApiClient — deployment methods", () => {
  it("listDeployments → GET /v1/endpoints with scope query + bearer token", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (url) =>
          url.startsWith(`${BASE_URL}/v1/endpoints?`) &&
          !url.includes("/keys"),
        respond: () =>
          new Response(
            JSON.stringify({ deployments: [SAMPLE_DEPLOYMENT] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const client = clientWith(f);
    const out = await client.listDeployments(SCOPE);
    expect(out.deployments).toHaveLength(1);
    expect(out.deployments[0].slug).toBe("myllama");

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(init.method).toBe("GET");
    expect(url).toContain("orgSlug=myorg");
    expect(url).toContain("projectSlug=myproj");
    // Headers are case-insensitive on the wire; Hono RPC normalises to
    // lowercase. Use the Headers API instead of indexing by exact case.
    const reqHeaders = new Headers(init.headers);
    expect(reqHeaders.get("authorization")).toBe("Bearer anon-test-token");
    expect(reqHeaders.get("x-arkor-client")).toMatch(/^arkor\/[\w.\-+]+$/);
  });

  it("createDeployment → POST /v1/endpoints with JSON body", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (url, init) =>
          init.method === "POST" &&
          url.startsWith(`${BASE_URL}/v1/endpoints?`),
        respond: () =>
          new Response(JSON.stringify({ deployment: SAMPLE_DEPLOYMENT }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      },
    ]);
    const client = clientWith(f);
    const input: CreateDeploymentInput = {
      slug: "myllama",
      target: { kind: "base_model", baseModel: "meta-llama/Llama-2-7b-hf" },
      authMode: "fixed_api_key",
      runRetentionMode: "days",
      runRetentionDays: 7,
    };
    const out = await client.createDeployment(SCOPE, input);
    expect(out.deployment.slug).toBe("myllama");

    const [{ init }] = calls;
    // Use the Headers API for case-insensitive lookup — Hono RPC sets the
    // header as `content-type` (lowercase) while raw fetch typically uses
    // `Content-Type`. The HTTP wire format is case-insensitive either way.
    const reqHeaders = new Headers(init.headers);
    expect(reqHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it("getDeployment → GET /v1/endpoints/:id", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (url, init) =>
          init.method === "GET" &&
          url.includes("/v1/endpoints/00000000-0000-4000-8000-000000000010"),
        respond: () =>
          new Response(JSON.stringify({ deployment: SAMPLE_DEPLOYMENT }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    ]);
    const client = clientWith(f);
    const out = await client.getDeployment(SAMPLE_DEPLOYMENT.id, SCOPE);
    expect(out.deployment.id).toBe(SAMPLE_DEPLOYMENT.id);
    // URL must include both the encoded id and the scope query.
    expect(calls[0].url).toContain(
      `/v1/endpoints/${encodeURIComponent(SAMPLE_DEPLOYMENT.id)}?`,
    );
  });

  it("updateDeployment → PATCH with partial body", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (_url, init) => init.method === "PATCH",
        respond: () =>
          new Response(
            JSON.stringify({
              deployment: { ...SAMPLE_DEPLOYMENT, enabled: false },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const client = clientWith(f);
    const out = await client.updateDeployment(SAMPLE_DEPLOYMENT.id, SCOPE, {
      enabled: false,
    });
    expect(out.deployment.enabled).toBe(false);
    // Body must be exactly what the caller passed — no extra fields.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      enabled: false,
    });
  });

  it("deleteDeployment → DELETE returns void on 204", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (_url, init) => init.method === "DELETE",
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const client = clientWith(f);
    await expect(
      client.deleteDeployment(SAMPLE_DEPLOYMENT.id, SCOPE),
    ).resolves.toBeUndefined();
    expect(calls[0].url).toContain(
      `/v1/endpoints/${encodeURIComponent(SAMPLE_DEPLOYMENT.id)}?`,
    );
  });

  it("listDeploymentKeys → GET /v1/endpoints/:id/keys (no plaintext in DTO)", async () => {
    const { fetch: f } = recordingFetch([
      {
        match: (url, init) =>
          init.method === "GET" && url.includes("/keys?"),
        respond: () =>
          new Response(
            JSON.stringify({
              keys: [
                {
                  id: "key-1",
                  label: "production",
                  prefix: "ark_live_abcd1234",
                  enabled: true,
                  createdAt: "2026-04-30T00:00:00.000Z",
                  lastUsedAt: null,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const client = clientWith(f);
    const out = await client.listDeploymentKeys(SAMPLE_DEPLOYMENT.id, SCOPE);
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0].label).toBe("production");
    // List view must not carry plaintext — schema would let it pass (looseObject)
    // but the production handler doesn't include it, so the assertion guards
    // against future regressions.
    expect(
      (out.keys[0] as unknown as Record<string, unknown>).plaintext,
    ).toBeUndefined();
  });

  it("createDeploymentKey → POST returns plaintext exactly once", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (url, init) =>
          init.method === "POST" && url.includes("/keys?"),
        respond: () =>
          new Response(
            JSON.stringify({
              key: {
                id: "key-1",
                label: "production",
                plaintext: "ark_live_PLAINTEXT_SENTINEL",
                prefix: "ark_live_PLAINTEX",
                createdAt: "2026-04-30T00:00:00.000Z",
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const client = clientWith(f);
    const out = await client.createDeploymentKey(SAMPLE_DEPLOYMENT.id, SCOPE, {
      label: "production",
    });
    expect(out.key.plaintext).toBe("ark_live_PLAINTEXT_SENTINEL");
    expect(out.key.prefix).toBe("ark_live_PLAINTEX");
    // Request body must carry the label as-is.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      label: "production",
    });
  });

  it("revokeDeploymentKey → DELETE :id/keys/:keyId resolves void on 204", async () => {
    const { fetch: f, calls } = recordingFetch([
      {
        match: (_url, init) => init.method === "DELETE",
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const client = clientWith(f);
    await expect(
      client.revokeDeploymentKey(SAMPLE_DEPLOYMENT.id, "key-1", SCOPE),
    ).resolves.toBeUndefined();
    expect(calls[0].url).toContain(
      `/v1/endpoints/${encodeURIComponent(SAMPLE_DEPLOYMENT.id)}/keys/key-1?`,
    );
  });

  it("propagates control-plane 409 as CloudApiError with the upstream message", async () => {
    const { fetch: f } = recordingFetch([
      {
        match: () => true,
        respond: () =>
          new Response(
            JSON.stringify({ error: "Deployment slug is already taken" }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    const client = clientWith(f);
    await expect(
      client.createDeployment(SCOPE, {
        slug: "taken",
        target: { kind: "base_model", baseModel: "m" },
        authMode: "none",
      }),
    ).rejects.toMatchObject({
      // CloudApiError instances carry the upstream status + message verbatim.
      // Matching by structure instead of `instanceof` keeps the test resilient
      // to module-instance differences under vitest workers.
      status: 409,
      message: expect.stringMatching(/already taken/),
    } satisfies Partial<CloudApiError>);
  });
});
