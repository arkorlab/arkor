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
 * otherwise: for anonymous credentials only: derives a slug from the cwd
 * basename, creates (or reuses on 409) the project, persists state, and
 * returns it. Auth0 callers without state must run `arkor init` first.
 *
 * Shared by the trainer (`createTrainer().start()`) and Studio's
 * `/api/inference/chat` so a fresh launch can hit base-model inference
 * without a prior `arkor init`.
 */
export async function ensureProjectState(
  options: EnsureProjectStateOptions,
): Promise<ArkorProjectState> {
  const { cwd, client, credentials } = options;
  const existing = await readState(cwd);
  if (existing) return existing;

  if (credentials.mode !== "anon") {
    throw new Error(
      "No .arkor/state.json found. Run `arkor init` to scaffold the project, or create .arkor/state.json manually with { orgSlug, projectSlug, projectId }.",
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
