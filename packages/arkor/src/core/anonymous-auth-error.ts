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
   * Whether OAuth is available on the current deployment. Tri-state:
   *
   * - `true`: confirmed available (cfg fetched, Auth0 fields present).
   *   The formatter recommends `arkor login --oauth`.
   * - `false`: confirmed *absent* (cfg fetched, no Auth0 fields). The
   *   formatter recommends `arkor login --anonymous` and explicitly
   *   tells the user OAuth isn't offered on this deployment.
   * - `undefined`: probe inconclusive (cfg fetch skipped, network
   *   blip, timeout, etc.). The formatter hedges by surfacing both
   *   commands and pointing at `--oauth` first because it works on
   *   the majority of deployments, with a clear fall-through to
   *   `--anonymous` if it fails.
   *
   * Mapping `undefined` to "OAuth not advertised" was the previous
   * behaviour and was misleading: a transient probe failure on an
   * OAuth-supporting deployment would steer users away from the
   * correct recovery.
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
  // The unknown-state branch surfaces both commands so users on an
  // OAuth-supporting deployment aren't denied the correct recovery
  // just because the config endpoint timed out. The order points at
  // `--oauth` first because it covers the majority of deployments;
  // anon-only users will get a clean "OAuth is not configured" error
  // and can fall through to the second command.
  const unknownTail = [
    "Couldn't reach the deployment to confirm whether OAuth is offered. Try the OAuth path first; if it fails with `OAuth is not configured`, fall through to the anonymous path:",
    "",
    "  arkor login --oauth",
    "  arkor login --anonymous",
  ];
  if (err.code === ANONYMOUS_TOKEN_SINGLE_DEVICE) {
    if (ctx.oauthAvailable === true) {
      return [
        "Anonymous credentials were rejected as single-device.",
        "Anonymous accounts only work on one machine. Sign up for an account that supports multiple devices:",
        "",
        "  arkor login --oauth",
      ].join("\n");
    }
    if (ctx.oauthAvailable === false) {
      return [
        "Anonymous credentials were rejected as single-device.",
        "Anonymous accounts only work on one machine. This deployment does not advertise OAuth, so the only recovery is to mint a new anonymous identity (your previous workspace data cannot be recovered):",
        "",
        "  arkor login --anonymous",
      ].join("\n");
    }
    return [
      "Anonymous credentials were rejected as single-device.",
      "Anonymous accounts only work on one machine.",
      "",
      ...unknownTail,
    ].join("\n");
  }
  if (err.code === ANONYMOUS_ACCOUNT_NOT_FOUND) {
    if (ctx.oauthAvailable === true) {
      return [
        "Your anonymous credentials are no longer valid.",
        "Sign up to continue:",
        "",
        "  arkor login --oauth",
      ].join("\n");
    }
    if (ctx.oauthAvailable === false) {
      return [
        "Your anonymous credentials are no longer valid.",
        "Mint a new anonymous identity to continue (your previous workspace data cannot be recovered):",
        "",
        "  arkor login --anonymous",
      ].join("\n");
    }
    return [
      "Your anonymous credentials are no longer valid.",
      "",
      ...unknownTail,
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
