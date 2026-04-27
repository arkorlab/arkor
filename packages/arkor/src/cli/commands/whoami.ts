import { CloudApiClient } from "../../core/client";
import {
  defaultArkorCloudApiUrl,
  readCredentials,
} from "../../core/credentials";
import { recordDeprecation } from "../../core/deprecation";
import { detectedUpgradeCommand } from "../../core/upgrade-hint";
import { SDK_VERSION } from "../../core/version";
import {
  createClient,
  upgradeMessageFromBody,
} from "@arkor/cloud-api-client";

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
      const body = await res.json().catch(() => null);
      const upgrade = upgradeMessageFromBody(status, body, {
        upgradeCommand: detectedUpgradeCommand(),
      });
      if (upgrade) {
        process.stderr.write(`${upgrade}\n`);
        // Hard-block: scripts that gate on `arkor whoami`'s exit code must
        // see a failure here. Use `exitCode` rather than `process.exit()`
        // so the deprecation-warning flush in `cli/main.ts` still runs.
        process.exitCode = 1;
        return;
      }
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
