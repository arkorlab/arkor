import { type CloudApiClient, CloudApiError } from "./client";
import { readState, writeState } from "./state";

import type { Credentials } from "./credentials";
import type { ArkorProjectState } from "./types";

export interface EnsureProjectStateOptions {
  cwd: string;
  client: CloudApiClient;
  credentials: Credentials;
}

/**
 * Single source of truth for the "OAuth caller hit a write path with
 * no `.arkor/state.json`" remediation copy. Studio's
 * `withDeploymentClient` (in `studio/server.ts`) imports this and
 * surfaces it verbatim on its 400 response so users see exactly the
 * same instruction whether they came from training, Playground, or
 * the Endpoints page. Wording drift between the two surfaces would
 * make the same setup problem look like two different bugs.
 */
export const OAUTH_MISSING_STATE_MESSAGE =
  "No .arkor/state.json found. Create it by hand with { orgSlug, projectSlug, projectId } pointing at the project you want to use.";

/**
 * Whether a persisted `.arkor/state.json` is usable for the active identity.
 *
 * Anonymous project state must belong to the current identity's org: a stale
 * file left by a previous anonymous identity (e.g. after `arkor logout`
 * followed by a fresh anonymous session, whether the new token was minted by
 * `arkor dev` or `arkor login --anonymous`) scopes cloud-api calls to an org
 * this token isn't a member of, so every scoped request 403s. OAuth state is
 * hand-maintained and can legitimately point at any org the user belongs to,
 * so it is always usable.
 *
 * Studio's read paths and `ensureProjectState` share this predicate so a
 * mismatched anonymous scope is ignored (and re-bootstrapped on write) rather
 * than deleted, so hand-maintained OAuth state is never discarded.
 */
export function isStateUsableFor(
  state: ArkorProjectState,
  credentials: Credentials,
): boolean {
  return isOrgUsableFor(state.orgSlug, credentials);
}

/**
 * The `state`-less core of `isStateUsableFor`: an org is usable for the given
 * credentials unless they are anonymous and the org isn't this identity's own.
 * Split out so the Studio deployment path can reconcile a `{ orgSlug }` scope
 * against a single resolved-credentials snapshot without materialising a full
 * `ArkorProjectState`.
 */
export function isOrgUsableFor(
  orgSlug: string,
  credentials: Credentials,
): boolean {
  return credentials.mode !== "anon" || orgSlug === credentials.orgSlug;
}

/**
 * Resolve the project scope (`orgSlug` / `projectSlug`) used to address
 * cloud-api endpoints. Returns existing `.arkor/state.json` when it is usable
 * for the caller (`isStateUsableFor`); otherwise (for anonymous credentials
 * only) derives a slug from the cwd basename, creates (or reuses on 409) the
 * project, persists state, and returns it. A mismatched anonymous scope is
 * only re-bootstrapped when its owner marker proves it belongs to a previous
 * anonymous identity; an unmarked (OAuth / hand-maintained) file is preserved
 * with a throw. OAuth callers without state cannot bootstrap automatically (we
 * don't know which org / project they want); they must write
 * `.arkor/state.json` by hand.
 *
 * Shared by the trainer (`createTrainer().start()`) and every Studio
 * write-path that needs a scope: `/api/inference/chat` (Playground), and
 * the deployment-create route used by the Endpoints page (the
 * `withDeploymentClient("create", …)` helper in `studio/server.ts`).
 * Other deployment write paths (`"mutate"`: PATCH / DELETE / key
 * CRUD) intentionally do NOT bootstrap; they 404 if the workspace has
 * no scope yet. That way a fresh anonymous launch can either chat
 * with a base model or publish its first `*.arkor.app` URL without
 * any prior setup, but a stray PATCH / DELETE on a non-existent
 * deployment id can't accidentally provision an orphan project.
 */
export async function ensureProjectState(
  options: EnsureProjectStateOptions,
): Promise<ArkorProjectState> {
  const { cwd, client, credentials } = options;
  const existing = await readState(cwd);
  if (existing && isStateUsableFor(existing, credentials)) {
    return existing;
  }

  // Mismatched existing state under anonymous credentials. Two sub-cases, told
  // apart by the anonymous-owner marker so we never silently overwrite a
  // hand-maintained OAuth scope (the read paths already preserve it):
  //   - marker present ⇒ a *previous anonymous identity's* stale scope. Safe
  //     to re-bootstrap over: that identity is gone (post-logout) and can't be
  //     recovered anyway.
  //   - marker absent ⇒ an OAuth-written or pre-marker legacy file. Preserve
  //     it and tell the user how to proceed, rather than clobbering their
  //     org / project selection with a fresh anonymous project.
  if (
    existing &&
    credentials.mode === "anon" &&
    existing.anonymousId === undefined
  ) {
    throw new Error(
      `.arkor/state.json is configured for a different account (org "${existing.orgSlug}"), but this is an anonymous session. Run \`arkor login --oauth\` to use it, or remove .arkor/state.json to start a fresh anonymous project.`,
    );
  }

  if (credentials.mode !== "anon") {
    // OAuth callers cannot bootstrap automatically: we don't know which
    // org / project the logged-in user wants. `arkor login` and `arkor
    // init` both leave `.arkor/state.json` untouched today (see
    // docs/concepts/project-structure), so the only working path is to
    // write the file by hand. The exact copy lives in the
    // `OAUTH_MISSING_STATE_MESSAGE` constant above so Studio's
    // server-side guard reuses the *same string*: in past rounds the
    // two strings drifted ("use" vs "manage"), which made the same
    // setup problem look like two different bugs depending on which
    // path the user hit.
    throw new Error(OAUTH_MISSING_STATE_MESSAGE);
  }
  const orgSlug = credentials.orgSlug;

  const baseName = cwd.split(/[/\\]/).findLast(Boolean) ?? "project";
  const dashy = baseName.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");
  // Hand-rolled dash-trim instead of `/^-+|-+$/g` (alternation with
  // two greedy `-+` branches is the CodeQL polynomial-ReDoS shape) or
  // even `/^-+/` + `/-+$/` (CodeQL still flags anchored greedy
  // repetition on uncontrolled input). Linear scan from each end is
  // unambiguously O(n).
  let start = 0;
  while (start < dashy.length && dashy[start] === "-") start++;
  let end = dashy.length;
  while (end > start && dashy[end - 1] === "-") end--;
  const projectSlug = dashy.slice(start, end).slice(0, 40) || "project";

  let project: { id: string; slug: string };
  try {
    const res = await client.createProject({
      orgSlug,
      name: baseName,
      slug: projectSlug,
    });
    project = res.project;
  } catch (err) {
    if (err instanceof CloudApiError && err.status === 409) {
      const { projects } = await client.listProjects(orgSlug);
      const found = projects.find((p) => p.slug === projectSlug);
      if (!found) throw err;
      project = found;
    } else {
      throw err;
    }
  }

  const state: ArkorProjectState = {
    orgSlug,
    projectSlug: project.slug,
    projectId: project.id,
    // Stamp the owner so a *later* anonymous identity can recognise this file
    // as a previous anonymous session's (safe to re-bootstrap over) rather
    // than a hand-maintained OAuth scope (which must be preserved).
    anonymousId: credentials.anonymousId,
  };
  await writeState(state, cwd);
  return state;
}
