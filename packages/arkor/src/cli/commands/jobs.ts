import { CloudApiClient, CloudApiError } from "../../core/client";
import {
  defaultArkorCloudApiUrl,
  ensureCredentials,
} from "../../core/credentials";
import { readState } from "../../core/state";
import { promptConfirm, ui } from "../prompts";

async function buildClient(): Promise<CloudApiClient> {
  const baseUrl = defaultArkorCloudApiUrl();
  const credentials = await ensureCredentials();
  return new CloudApiClient({ baseUrl, credentials });
}

async function requireScope(): Promise<{
  orgSlug: string;
  projectSlug: string;
}> {
  const state = await readState();
  if (!state) {
    throw new Error(
      "No .arkor/state.json found. Run `arkor init` or execute a training run first.",
    );
  }
  return { orgSlug: state.orgSlug, projectSlug: state.projectSlug };
}

export async function runJobsList(): Promise<void> {
  const scope = await requireScope();
  const creds = await ensureCredentials();
  const token = creds.mode === "anon" ? creds.token : creds.accessToken;
  const url = `${defaultArkorCloudApiUrl()}/v1/jobs?orgSlug=${encodeURIComponent(scope.orgSlug)}&projectSlug=${encodeURIComponent(scope.projectSlug)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new CloudApiError(
      res.status,
      (await res.text().catch(() => "")) || `cloud-api ${res.status}`,
    );
  }
  const { jobs } = (await res.json()) as {
    jobs: Array<Record<string, unknown>>;
  };
  if (jobs.length === 0) {
    process.stdout.write("No jobs yet.\n");
    return;
  }
  for (const j of jobs) {
    const status = String(j.status ?? "");
    const id = String(j.id ?? "");
    const name = String(j.name ?? "");
    process.stdout.write(`${status.padEnd(10)} ${id} ${name}\n`);
  }
}

export async function runJobsGet(id: string): Promise<void> {
  const client = await buildClient();
  const scope = await requireScope();
  const { job, events } = await client.getJob(id, scope);
  process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
  process.stdout.write(`Events: ${events?.length ?? 0}\n`);
}

export interface JobsCancelOptions {
  yes?: boolean;
}

export async function runJobsCancel(
  id: string,
  options: JobsCancelOptions = {},
): Promise<void> {
  const confirmed = await promptConfirm({
    message: `Cancel job ${id}? This cannot be undone.`,
    initialValue: false,
    skipWith: options.yes ? true : undefined,
  });
  if (!confirmed) {
    ui.log.info("Aborted.");
    return;
  }
  const client = await buildClient();
  const scope = await requireScope();
  await client.cancelJob(id, scope);
  ui.log.success(`Job ${id} cancelled.`);
}
