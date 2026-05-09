import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { anonymousTokenResponseSchema } from "./schemas";
import { SDK_VERSION } from "./version";

export interface Auth0Credentials {
  mode: "auth0";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  auth0Domain: string;
  audience: string;
  clientId: string;
  /**
   * The cloud API base URL the user authenticated against. Captured at
   * `arkor login` time so the SDK / Studio can keep targeting the same
   * staging / self-hosted control plane on subsequent runs without
   * needing `ARKOR_CLOUD_API_URL` re-set every time. Optional for
   * backward compatibility with credentials persisted before this
   * field was introduced — `defaultArkorCloudApiUrl` falls through to
   * the production endpoint when it's missing.
   */
  arkorCloudApiUrl?: string;
}

export interface AnonymousCredentials {
  mode: "anon";
  token: string;
  anonymousId: string;
  arkorCloudApiUrl: string;
  /** Captured at signup so we can bootstrap project state without an extra round-trip. */
  orgSlug: string;
}

export type Credentials = Auth0Credentials | AnonymousCredentials;

/**
 * Thrown by `requestAnonymousToken` when the cloud-api responds with a
 * non-2xx status while requesting an anonymous token.
 *
 * Covers both explicit deployment-side rejection (e.g. anonymous tokens
 * disabled — typically 401/403/404) and other HTTP failures such as
 * transient 5xx server errors. Distinct from transport failures (raw
 * `TypeError("fetch failed")`), schema mismatches (`ZodError`), and
 * local fs errors so callers can pattern-match on "anon endpoint
 * returned an HTTP error" separately and inspect `status` to decide
 * how to react. `arkor dev` only wraps 4xx as a sign-in hint, leaving
 * 5xx to surface with its original message.
 */
export class AnonymousTokenRejectedError extends Error {
  readonly status: number;
  constructor(status: number, bodySnippet: string) {
    super(`Failed to acquire anonymous token (${status}): ${bodySnippet}`);
    this.name = "AnonymousTokenRejectedError";
    this.status = status;
  }
}

function credentialsDir(): string {
  return join(homedir(), ".arkor");
}

export function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

/**
 * Path to the per-launch Studio CSRF token file.
 *
 * Source of truth: `arkor dev` writes the token here on start (mode 0600) and
 * deletes it on exit. The studio-app Vite dev server reads from this same
 * path via a `transformIndexHtml` plugin so the SPA receives the token even
 * when served by Vite (which doesn't go through `buildStudioApp`'s injection).
 */
export function studioTokenPath(): string {
  return join(credentialsDir(), "studio-token");
}

export async function readCredentials(): Promise<Credentials | null> {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Credentials;
}

export async function writeCredentials(credentials: Credentials): Promise<void> {
  const dir = credentialsDir();
  const path = credentialsPath();
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function getToken(credentials: Credentials): Promise<string> {
  return credentials.mode === "anon"
    ? credentials.token
    : credentials.accessToken;
}

/**
 * Resolve the cloud API base URL the SDK / CLI should target.
 *
 * Priority order:
 *   1. `ARKOR_CLOUD_API_URL` env var (trailing slash stripped). Empty
 *      string is honoured — an operator who set `=""` intentionally
 *      (so a config error surfaces at first fetch instead of silently
 *      hitting production) sees `""` propagated.
 *   2. `arkorCloudApiUrl` from the loaded credentials. Both
 *      `AnonymousCredentials` (stamped at signup) and
 *      `Auth0Credentials` (stamped at `arkor login` time, since
 *      `Auth0Credentials.arkorCloudApiUrl` was added) carry the URL
 *      they were issued against, so subsequent runs keep targeting
 *      the same staging / self-hosted control plane without
 *      `ARKOR_CLOUD_API_URL` re-set. Empty string is honoured here
 *      too for the same reason as the env var.
 *   3. The production endpoint `https://api.arkor.ai`. This branch
 *      catches missing `arkorCloudApiUrl` only — the legacy case for
 *      OAuth tokens persisted before the field existed. Those
 *      credentials need a re-login (or `ARKOR_CLOUD_API_URL` set
 *      explicitly) to follow a non-production control plane.
 *
 * Exposed as a public helper because `CloudApiClient` requires an
 * explicit `baseUrl` and the SDK doesn't otherwise hand consumers a
 * supported way to recover the credential-bound URL. Without it,
 * scripts that reuse `readCredentials()` after `arkor login` would
 * have no way to target the same staging / self-hosted control plane
 * the user actually authenticated against.
 */
export function defaultArkorCloudApiUrl(
  credentials?: Credentials | null,
): string {
  // `!= null` (not truthy) preserves the original env-handling: an
  // explicitly empty `ARKOR_CLOUD_API_URL = ""` still propagates so a
  // misconfigured env triggers the URL-parse error at startup instead
  // of being silently substituted with the production fallback. Tests
  // exercise that exact behaviour to surface config bugs early.
  const fromEnv = process.env.ARKOR_CLOUD_API_URL?.replace(/\/$/, "");
  if (fromEnv !== undefined) return fromEnv;
  // Both shapes carry an optional `arkorCloudApiUrl`: anonymous since
  // signup, OAuth since login. `!= null` (not truthy) keeps an empty
  // string round-tripping the same way the env-var branch above
  // does — an operator who logged in with `ARKOR_CLOUD_API_URL=""`
  // intentionally to surface config errors should see that
  // propagated through the persisted credentials, not silently
  // substituted with production. Falling back to production for
  // *missing* `arkorCloudApiUrl` (legacy creds, e.g. tokens written
  // before the field existed) is still safe: the worst outcome
  // there is a 401 against the wrong control plane, which is what
  // the operator hits today on those legacy tokens anyway.
  if (
    credentials?.arkorCloudApiUrl !== undefined &&
    credentials?.arkorCloudApiUrl !== null
  ) {
    return credentials.arkorCloudApiUrl.replace(/\/$/, "");
  }
  return "https://api.arkor.ai";
}

/**
 * POST /v1/auth/anonymous against the given base URL and return the response.
 * Extracted so callers (credentials bootstrap, tests) can share it.
 */
export async function requestAnonymousToken(
  baseUrl: string,
  kind: "cli" | "web" = "cli",
): Promise<{
  token: string;
  anonymousId: string;
  kind: "cli" | "web";
  orgSlug: string;
}> {
  const res = await fetch(`${baseUrl}/v1/auth/anonymous`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arkor-Client": `arkor/${SDK_VERSION}`,
    },
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AnonymousTokenRejectedError(res.status, text.slice(0, 500));
  }
  const parsed = anonymousTokenResponseSchema.parse(await res.json());
  return {
    token: parsed.token,
    anonymousId: parsed.anonymousId,
    kind: parsed.kind,
    orgSlug: parsed.personalOrg.slug,
  };
}

/**
 * Load credentials from disk, or bootstrap a fresh anonymous identity
 * against the default cloud API URL and persist it.
 */
export async function ensureCredentials(): Promise<Credentials> {
  const existing = await readCredentials();
  if (existing) return existing;

  const baseUrl = defaultArkorCloudApiUrl();
  const anon = await requestAnonymousToken(baseUrl, "cli");
  const creds: AnonymousCredentials = {
    mode: "anon",
    token: anon.token,
    anonymousId: anon.anonymousId,
    arkorCloudApiUrl: baseUrl,
    orgSlug: anon.orgSlug,
  };
  await writeCredentials(creds);
  return creds;
}
