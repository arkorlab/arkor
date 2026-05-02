import { CloudApiError } from "./client";

/**
 * Structured error codes the cloud-api emits on anonymous auth-state
 * failures. Mirrors the strings produced by control-plane's
 * `anonymous_users` middleware + `rotate-jti` route. Keep this list in
 * sync if the server adds new ones.
 */
export const ANONYMOUS_TOKEN_SINGLE_DEVICE = "anonymous_token_single_device";
export const ANONYMOUS_ACCOUNT_NOT_FOUND = "anonymous_account_not_found";

export interface FormatAnonymousAuthErrorContext {
  /**
   * Whether OAuth is *confirmed* available on the current deployment.
   * Same gating contract as the login/dev surfaces: only a `true` value
   * unlocks the `arkor login --oauth` recovery hint. `false` /
   * `undefined` (cfg fetch skipped or failed) fall back to the
   * `arkor login --anonymous` re-mint path, which is the only recovery
   * that works on every supported deployment shape — pointing anon-only
   * users at `--oauth` would just send them to a command that fails
   * immediately.
   */
  oauthAvailable?: boolean;
}

/**
 * If `err` is a `CloudApiError` whose `code` indicates an anonymous-auth
 * dead-end, return a CLI-shaped message guiding the user to recovery.
 * Returns `null` for everything else so callers can re-throw.
 *
 * The two recoverable cases differ in cause:
 *
 * - `anonymous_token_single_device`: another device or a racing refresh
 *   rotated `latest_jti` past ours. Signal that anonymous accounts are
 *   single-device on purpose; the path forward depends on whether OAuth
 *   is configured (sign up vs. mint a new throwaway anon).
 * - `anonymous_account_not_found`: the `anonymous_users` row is gone
 *   (admin / cascade / explicit revocation). Token can't be salvaged;
 *   user has to either sign up (OAuth) or start fresh as anon.
 */
export function formatAnonymousAuthError(
  err: unknown,
  ctx: FormatAnonymousAuthErrorContext = {},
): string | null {
  if (!(err instanceof CloudApiError)) return null;
  const oauthLine =
    ctx.oauthAvailable === true
      ? "  arkor login --oauth"
      : "  arkor login --anonymous";
  if (err.code === ANONYMOUS_TOKEN_SINGLE_DEVICE) {
    if (ctx.oauthAvailable === true) {
      return [
        "Anonymous credentials were rejected as single-device.",
        "Anonymous accounts only work on one machine. Sign up for an account that supports multiple devices:",
        "",
        oauthLine,
      ].join("\n");
    }
    return [
      "Anonymous credentials were rejected as single-device.",
      "Anonymous accounts only work on one machine. This deployment does not advertise OAuth, so the only recovery is to mint a new anonymous identity (your previous workspace data cannot be recovered):",
      "",
      oauthLine,
    ].join("\n");
  }
  if (err.code === ANONYMOUS_ACCOUNT_NOT_FOUND) {
    if (ctx.oauthAvailable === true) {
      return [
        "Your anonymous credentials are no longer valid.",
        "Sign up to continue:",
        "",
        oauthLine,
      ].join("\n");
    }
    return [
      "Your anonymous credentials are no longer valid.",
      "Mint a new anonymous identity to continue (your previous workspace data cannot be recovered):",
      "",
      oauthLine,
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
