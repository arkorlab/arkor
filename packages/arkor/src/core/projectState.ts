import { CloudApiClient, CloudApiError } from "./client";
import type { Credentials } from "./credentials";
import { readState, writeState } from "./state";
import type { ArkorProjectState } from "./types";

export interface EnsureProjectStateOptions {
  cwd: string;
  client: CloudApiClient;
  credentials: Credentials;
}

/**
 * Resolve the project scope (`orgSlug` / `projectSlug`) used to address
 * cloud-api endpoints. Returns existing `.arkor/state.json` if present;
 * otherwise — for anonymous credentials only — derives a slug from the cwd
 * basename, creates (or reuses on 409) the project, persists state, and
 * returns it. Auth0 callers without state cannot bootstrap automatically
 * (we don't know which org / project they want); they must write
 * `.arkor/state.json` by hand.
 *
 * Shared by the trainer (`createTrainer().start()`) and Studio's
 * `/api/inference/chat` so a fresh anonymous launch can hit base-model
 * inference without any prior setup.
 */
export async function ensureProjectState(
  options: EnsureProjectStateOptions,
): Promise<ArkorProjectState> {
  const { cwd, client, credentials } = options;
  const existing = await readState(cwd);
  if (existing) return existing;

  if (credentials.mode !== "anon") {
    // Auth0 callers cannot bootstrap automatically: we don't know which
    // org / project the logged-in user wants. `arkor login` and `arkor
    // init` both leave `.arkor/state.json` untouched today (see
    // docs/concepts/project-structure), so the only working path is to
    // write the file by hand. Keep this message in sync with the Studio
    // server's identical guard in `studio/server.ts` so users hit the
    // same instruction whether they came from the Playground / training
    // / Endpoints flow.
    throw new Error(
      "No .arkor/state.json found. Create it by hand with { orgSlug, projectSlug, projectId } pointing at the project you want to use.",
    );
  }
  const orgSlug = credentials.orgSlug;

  const baseName = cwd.split(/[/\\]/).filter(Boolean).pop() ?? "project";
  const projectSlug =
    baseName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";

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
