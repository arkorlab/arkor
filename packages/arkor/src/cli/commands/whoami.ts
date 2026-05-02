import { buildCloudApiError, CloudApiClient } from "../../core/client";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
} from "../../core/credentials";
import { recordDeprecation } from "../../core/deprecation";
import { formatSdkUpgradeError } from "../../core/upgrade-hint";
import { SDK_VERSION } from "../../core/version";
import { ANON_SINGLE_DEVICE_NOTE } from "../anonymous";
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
  process.stdout.write(`${JSON.stringify(body.user, null, 2)}\n`);
  if (body.orgs.length > 0) {
    process.stdout.write(
      `Orgs: ${body.orgs.map((o) => String(o.slug ?? o.id)).join(", ")}\n`,
    );
  }
  if (creds.mode === "anon") {
    // Anonymous accounts are single-device on purpose, so surface the
    // limitation here so users discover it before hitting a 401 on a
    // second machine. We key off `creds.mode` (already in scope from
    // `readCredentials()`) rather than `body.user.kind` because the
    // cloud-api's `/v1/me` schema doesn't guarantee a `kind` field on
    // the response — relying on it would silently skip the note for
    // anonymous users on every deployment that doesn't surface the
    // discriminator.
    //
    // We deliberately emit the *bare* fact rather than the
    // OAuth-flavoured variant: `whoami` doesn't fetch
    // `/v1/auth/cli/config`, so it can't tell whether OAuth is offered,
    // and steering anon-only users at `arkor login --oauth` would point
    // them at a command that fails immediately. The matching login/dev
    // surfaces, which already know `oauthAvailable`, do append the
    // upgrade hint when warranted.
    process.stdout.write(`\n${ANON_SINGLE_DEVICE_NOTE}\n`);
  }
  // Avoid "unused import" noise by referencing CloudApiClient in an assertion.
  void CloudApiClient;
}
