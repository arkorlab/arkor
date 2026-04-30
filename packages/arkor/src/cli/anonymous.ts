import { requestAnonymousToken } from "../core/credentials";

/** Re-export under a stable name used by multiple CLI commands. */
export async function acquireAnonymousTokenResult(baseUrl: string) {
  return requestAnonymousToken(baseUrl, "cli");
}

// Persistence nudge surfaced after every anonymous-credential issuance.
// Three constraints baked into the wording — kept as the single source of
// truth so `login.ts` and `dev.ts` cannot drift on the user-visible copy:
//
//   1. Anon-scoped work has no SLA on the cloud-api side (no account
//      binding, eligible for cleanup), so users should know to upgrade
//      before they invest real work.
//   2. `arkor login --oauth` overwrites the credentials file (see
//      `credentialsPath()` in `core/credentials.ts`) under a new identity
//      — there is no server-side path to carry an existing anon id's
//      work into a future OAuth org. The copy therefore targets
//      *future* work rather than implying existing artifacts will be
//      saved or transferred. Surfacing that limitation directly would
//      just discourage the upgrade we want users to take; revisit when a
//      migration path actually ships server-side.
//   3. Callers must gate emission on `oauthAvailable === true` — i.e.
//      suppress the nudge whenever OAuth availability is *not* confirmed,
//      including the "unknown" case (cfg fetch skipped on the explicit
//      `--anonymous` shortcut, or cfg fetch failed). Pointing at `arkor
//      login --oauth` on an anon-only deployment would contradict the
//      "OAuth is not configured" message and steer users at a command
//      that fails immediately, so erring on suppression is safer than
//      defaulting to show.
export const ANON_PERSISTENCE_NUDGE =
  "Anonymous sessions aren't guaranteed to persist — sign in with `arkor login --oauth` to tie future work to your Arkor Cloud account.";
