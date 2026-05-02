import { buildCloudApiError, CloudApiClient } from "../../core/client";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
} from "../../core/credentials";
import { recordDeprecation } from "../../core/deprecation";
import { formatSdkUpgradeError } from "../../core/upgrade-hint";
import { SDK_VERSION } from "../../core/version";
import { createClient } from "@arkor/cloud-api-client";

export async function runWhoami(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    process.stdout.write(
      "Not signed in. Run `arkor login` or `arkor login --anonymous`.\n",
    );
    return;
  }
  const baseUrl = defaultArkorCloudApiUrl();
  // Use the RPC client directly for /v1/me rather than CloudApiClient so we
  // hit the typed surface and avoid duplicating the plumbing.
  const rpc = createClient({
    baseUrl,
    token: () =>
      creds.mode === "anon" ? creds.token : creds.accessToken,
    clientVersion: SDK_VERSION,
    onDeprecation: recordDeprecation,
  });
  const res = await rpc.v1.me.$get();
  if (!res.ok) {
    // Hono RPC narrows `status` to the success codes declared in the OpenAPI
    // schema (200 here), so widen for the 426 check below.
    const status: number = res.status;
    if (status === 426) {
      // Always treat 426 as a hard block, even if the body is missing /
      // non-JSON / not the gate's expected shape. `formatSdkUpgradeError`
      // returns a generic fallback in that case so we never silently fall
      // through to the "Token may be expired" branch on a real version
      // rejection.
      const body = await res.json().catch(() => null);
      process.stderr.write(`${formatSdkUpgradeError(body)}\n`);
      // `exitCode` (not `process.exit()`) so the deprecation-warning flush
      // in `cli/main.ts` still runs before exit.
      process.exitCode = 1;
      return;
    }
    // Throw a `CloudApiError` carrying the structured `code` so the
    // top-level handler in `cli/main.ts` can format anonymous auth-state
    // failures (`anonymous_token_single_device`,
    // `anonymous_account_not_found`) into actionable guidance instead of
    // a generic "Token may be expired" line.
    throw await buildCloudApiError(res);
  }
  const body = (await res.json()) as {
    user: Record<string, unknown>;
    orgs: Record<string, unknown>[];
  };
  const isAnonymous =
    typeof body.user === "object" &&
    body.user !== null &&
    (body.user as { kind?: unknown }).kind === "anonymous";
  process.stdout.write(`${JSON.stringify(body.user, null, 2)}\n`);
  if (body.orgs.length > 0) {
    process.stdout.write(
      `Orgs: ${body.orgs.map((o) => String(o.slug ?? o.id)).join(", ")}\n`,
    );
  }
  if (isAnonymous) {
    // Anonymous accounts are single-device on purpose, so surface the
    // limitation here so users discover it before hitting a 401 on a
    // second machine. `arkor login --oauth` is the explicit upgrade
    // path; phrasing matches the auth-error formatter so users see the
    // same advice from both surfaces.
    process.stdout.write(
      "\nNote: anonymous accounts work on this machine only. Run `arkor login --oauth` to sign up for multi-device access.\n",
    );
  }
  // Avoid "unused import" noise by referencing CloudApiClient in an assertion.
  void CloudApiClient;
}
