import { CloudApiError } from "./client";

/**
 * Structured error codes the cloud-api emits on anonymous auth-state
 * failures. Mirrors the strings produced by control-plane's
 * `anonymous_users` middleware + `rotate-jti` route. Keep this list in
 * sync if the server adds new ones.
 */
export const ANONYMOUS_TOKEN_SINGLE_DEVICE = "anonymous_token_single_device";
export const ANONYMOUS_ACCOUNT_NOT_FOUND = "anonymous_account_not_found";

/**
 * If `err` is a `CloudApiError` whose `code` indicates an anonymous-auth
 * dead-end, return a CLI-shaped message guiding the user to recovery.
 * Returns `null` for everything else so callers can re-throw.
 *
 * The two cases share an end-user action (`arkor login --oauth`) but
 * differ in cause:
 *
 * - `anonymous_token_single_device`: another device or a racing refresh
 *   rotated `latest_jti` past ours. Signal that anonymous accounts are
 *   single-device on purpose; the path forward is signing up via OAuth.
 * - `anonymous_account_not_found`: the `anonymous_users` row is gone
 *   (admin / cascade / explicit revocation). Token can't be salvaged.
 */
export function formatAnonymousAuthError(err: unknown): string | null {
  if (!(err instanceof CloudApiError)) return null;
  if (err.code === ANONYMOUS_TOKEN_SINGLE_DEVICE) {
    return [
      "Anonymous credentials were rejected as single-device.",
      "Anonymous accounts only work on one machine. Sign up for an account that supports multiple devices:",
      "",
      "  arkor login --oauth",
    ].join("\n");
  }
  if (err.code === ANONYMOUS_ACCOUNT_NOT_FOUND) {
    return [
      "Your anonymous credentials are no longer valid.",
      "Sign up to continue:",
      "",
      "  arkor login --oauth",
    ].join("\n");
  }
  return null;
}

/**
 * `true` if the error is one of the auth-state codes formatted by
 * `formatAnonymousAuthError`. Useful for callers that want to skip
 * silent retries (e.g. don't keep looping on a token the server already
 * rejected as single-device).
 */
export function isAnonymousAuthDeadEnd(err: unknown): err is CloudApiError {
  return (
    err instanceof CloudApiError &&
    (err.code === ANONYMOUS_TOKEN_SINGLE_DEVICE ||
      err.code === ANONYMOUS_ACCOUNT_NOT_FOUND)
  );
}
