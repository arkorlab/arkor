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
 * Resolve the project scope (`orgSlug` / `projectSlug`) used to address
 * cloud-api endpoints. Returns existing `.arkor/state.json` if present;
 * otherwise (for anonymous credentials only) derives a slug from the cwd
 * basename, creates (or reuses on 409) the project, persists state, and
 * returns it. OAuth callers without state cannot bootstrap automatically
 * (we don't know which org / project they want); they must write
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
  // Anonymous project state must belong to the current identity's org. A
  // stale `.arkor/state.json` left by a previous anonymous identity (e.g.
  // after `arkor logout` followed by a fresh anonymous session) scopes
  // cloud-api calls to an org this token can't access, so createJob /
  // createDeployment would 403 against it. Ignore it and re-bootstrap under
  // the current org. OAuth state is hand-maintained and can legitimately
  // point at any org the user belongs to, so it is always honoured.
  if (
    existing &&
    (credentials.mode !== "anon" || existing.orgSlug === credentials.orgSlug)
  ) {
    return existing;
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
