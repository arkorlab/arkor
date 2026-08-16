import type { Credentials } from "./credentials";

/**
 * Local-mode contract between the arkor CLI and the SDK.
 *
 * `arkor start --local` / `arkor dev --local` boot a local training server
 * (provided by the separately installed `@arkor/local` package) and expose it
 * to everything downstream through two environment variables. The variables
 * are the whole hand-off: the trainer inside the user's build artifact is
 * constructed by the project's own installed `arkor` copy, so no in-process
 * value can reach it, and Studio's "Run training" button spawns `arkor start`
 * as a child process that must inherit the same server.
 *
 * `ARKOR_CLOUD_API_URL` is intentionally NOT reused for this: its
 * empty-string semantics are load-bearing in `defaultArkorCloudApiUrl`, and
 * local mode must also flip behaviour that a base-URL override alone cannot
 * (credential resolution, project-state bootstrap, the supported-model gate).
 */
export const LOCAL_SERVER_URL_ENV = "ARKOR_LOCAL_SERVER_URL";
export const LOCAL_SERVER_TOKEN_ENV = "ARKOR_LOCAL_SERVER_TOKEN";
/** Optional backend id override, set by `--backend <id>`. */
export const LOCAL_BACKEND_ENV = "ARKOR_LOCAL_BACKEND";

export interface LocalMode {
  /** Base URL of the running local training server (loopback). */
  baseUrl: string;
  /** Per-launch bearer token the local server requires on every request. */
  token: string;
}

/**
 * Read the local-mode hand-off from the environment. Returns `null` when
 * local mode is off. Throws when the hand-off is half-set: that only happens
 * when something outside the CLI exports one variable by hand, and silently
 * proceeding would either send unauthenticated requests (missing token) or
 * hit the cloud with a dummy identity (missing URL).
 */
export function readLocalMode(
  env: Record<string, string | undefined> = process.env,
): LocalMode | null {
  const baseUrl = env[LOCAL_SERVER_URL_ENV];
  const token = env[LOCAL_SERVER_TOKEN_ENV];
  if (!baseUrl && !token) return null;
  if (!baseUrl || !token) {
    throw new Error(
      `${LOCAL_SERVER_URL_ENV} and ${LOCAL_SERVER_TOKEN_ENV} must be set ` +
        "together. They are managed by `arkor start --local` / " +
        "`arkor dev --local`; unset the stray variable instead of setting " +
        "them by hand.",
    );
  }
  return { baseUrl, token };
}

/**
 * Fixed org/project scope used for every local job. The local server accepts
 * and ignores scope query params, so the exact value only has to be stable
 * and recognisably non-cloud.
 */
export const LOCAL_SCOPE = Object.freeze({
  orgSlug: "local",
  projectSlug: "local",
});

/**
 * In-memory credentials for talking to the local server. Never persisted:
 * writing these to `~/.arkor/credentials.json` would poison later cloud use
 * (the stamped `arkorCloudApiUrl` would point at a dead loopback port), so
 * local mode bypasses `ensureCredentials` entirely and hands this object
 * straight to the client.
 */
export function localCredentials(local: LocalMode): Credentials {
  return {
    mode: "anon",
    token: local.token,
    anonymousId: "local",
    arkorCloudApiUrl: local.baseUrl,
    orgSlug: LOCAL_SCOPE.orgSlug,
  };
}
