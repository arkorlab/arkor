import { iterateEvents } from "@arkor/cloud-api-client";
import { CloudApiClient } from "../../core/client";
import {
  defaultArkorCloudApiUrl,
  ensureCredentials,
} from "../../core/credentials";
import { readState } from "../../core/state";

export interface LogsOptions {
  follow?: boolean;
}

export async function runLogs(
  jobId: string,
  options: LogsOptions = {},
): Promise<void> {
  const baseUrl = defaultArkorCloudApiUrl();
  const credentials = await ensureCredentials();
  const client = new CloudApiClient({ baseUrl, credentials });
  const state = await readState();
  if (!state) {
    throw new Error(
      "No .arkor/state.json found. Run `arkor init` or execute a training run first.",
    );
  }
  const scope = { orgSlug: state.orgSlug, projectSlug: state.projectSlug };

  if (!options.follow) {
    const { events } = await client.getJob(jobId, scope);
    for (const e of events ?? []) {
      process.stdout.write(`${JSON.stringify(e)}\n`);
    }
    return;
  }

  let lastEventId: string | undefined;
  // Indefinite loop until we see `event: end` — the same shape the trainer
  // consumes, but we just print instead of dispatching callbacks.
  while (true) {
    const res = await client.openEventStream(jobId, scope, { lastEventId });
    let ended = false;
    for await (const sse of iterateEvents(res)) {
      if (sse.id) lastEventId = sse.id;
      if (sse.event === "ping") continue;
      if (sse.event === "end") {
        ended = true;
        break;
      }
      process.stdout.write(`[${sse.event ?? "msg"}] ${sse.data}\n`);
    }
    if (ended) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
