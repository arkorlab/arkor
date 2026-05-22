import { CloudApiClient } from "../../core/client";
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
  // Pass the loaded credentials so `/v1/me` lands on the same control
  // plane the user authenticated against — anonymous tokens carry the
  // signup URL, OAuth tokens carry the login URL since round 67.
  // Without this, an OAuth user who signed in against staging would
  // see `arkor whoami` 401 against production unless they also kept
  // `ARKOR_CLOUD_API_URL` set in their shell.
  const baseUrl = defaultArkorCloudApiUrl(creds);
  // Use the RPC client directly for /v1/me rather than CloudApiClient so we
  // hit the typed surface and avoid duplicating the plumbing.
  const rpc = createClient({
    baseUrl,
    token: () =>
      creds.mode === "anon" ? creds.token : creds.accessToken,
    clientVersion: SDK_VERSION,
    // Wrap the deprecation callback so we return `null` (not `void`) —
    // `@arkor/cloud-api-client` alpha.2 feeds the handler's return into
    // `typeof result.then === 'function'`, which throws on a `void`
    // return and logs `[@arkor/cloud-api-client] onDeprecation handler
    // threw; ignoring:` on every deprecated `/v1/me` response. Same
    // workaround as `CloudApiClient` and Studio's `createRpc`. Drop
    // when alpha.3+ ships the upstream fix.
    onDeprecation: (notice) => {
      recordDeprecation(notice);
      return null;
    },
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
    process.stdout.write(
      `Failed to fetch /v1/me (${status}). Token may be expired.\n`,
    );
    return;
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
  // Avoid "unused import" noise by referencing CloudApiClient in an assertion.
  void CloudApiClient;
}
