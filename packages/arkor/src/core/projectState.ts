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
 * Thrown when an anonymous session resolves project state that is scoped to an
 * org it can't use (see `ANON_STATE_MISMATCH_MESSAGE`). A distinct type so the
 * Studio write handlers (`/api/inference/chat`, the deployment proxy) can map
 * this *recoverable* setup conflict to a 409 with the actionable message,
 * instead of collapsing it into the generic "Studio backend" 500 they return
 * for genuinely unexpected errors.
 */
export class ProjectStateMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStateMismatchError";
  }
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
 * Shown when an anonymous session finds a `.arkor/state.json` scoped to an org
 * it can't use. The file is left untouched (it may be a hand-maintained OAuth
 * scope, or a leftover from a previous anonymous identity; the two are
 * indistinguishable, so we never overwrite it) and the user is pointed at the
 * two safe recoveries. `ensureProjectState` throws it and Studio's deployment
 * path returns it, so both surfaces read identically.
 */
export const ANON_STATE_MISMATCH_MESSAGE =
  "This workspace's .arkor/state.json is scoped to a different organization than your current anonymous session. Delete .arkor/state.json to start a fresh anonymous project, or run `arkor login` with the account that owns that project.";

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
 * Studio's read paths and `ensureProjectState` share this predicate. Read
 * paths ignore an unusable scope; the write path refuses to overwrite it.
 * Either way the file is never deleted, so a hand-maintained OAuth scope
 * survives.
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
 * for the caller (`isStateUsableFor`). When it is present but NOT usable (an
 * anonymous session whose state points at a different org), it is never
 * overwritten (we can't tell a previous anonymous identity's leftover from a
 * hand-maintained OAuth scope), so we throw `ANON_STATE_MISMATCH_MESSAGE`
 * pointing at the safe recoveries. Only when there is NO state (and the caller
 * is anonymous) do we derive a slug from the cwd basename, create (or reuse on
 * 409) the project, persist state, and return it. OAuth callers without state
 * cannot bootstrap automatically (we don't know which org / project they
 * want); they must write `.arkor/state.json` by hand.
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

  // Reaching here means `existing` is present but not usable (an anonymous
  // session pointed at an org it can't use; OAuth callers with any state
  // returned above). We can't tell a previous anonymous identity's leftover
  // apart from a hand-maintained OAuth scope (state.json carries no reliable
  // owner marker), and overwriting either would destroy the user's project
  // selection, so we never bootstrap over it. Surface the two safe recoveries
  // instead. The read paths already ignore this same file, so `arkor dev`
  // Studio stays usable; only these write paths need the file cleared first.
  if (existing) {
    throw new ProjectStateMismatchError(ANON_STATE_MISMATCH_MESSAGE);
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
  };
  await writeState(state, cwd);
  return state;
}
