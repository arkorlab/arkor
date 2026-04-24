import { requestAnonymousToken } from "../core/credentials";

/** Re-export under a stable name used by multiple CLI commands. */
export async function acquireAnonymousTokenResult(baseUrl: string) {
  return requestAnonymousToken(baseUrl, "cli");
}
