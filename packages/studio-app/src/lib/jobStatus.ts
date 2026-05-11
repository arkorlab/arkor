import type { Job } from "./api";

export type DisplayStatus = Job["status"] | "provisioning";

export interface ComputeDisplayStatusInput {
  job: { status: Job["status"]; createdAt?: string } | null | undefined;
  liveStatus?: Job["status"] | null;
  terminalStatus?: "completed" | "failed" | null;
  eventStreamConnected?: boolean;
  now?: number;
  recentMs?: number;
}

const DEFAULT_RECENT_MS = 90_000;

/**
 * Resolve the status to show in the UI. Wire status (`Job["status"]`)
 * only carries queued / running / completed / failed / cancelled; this
 * synthesises `provisioning` for a queued job whose SSE stream is open
 * (or whose createdAt is within `recentMs`) so the UI can tell "GPU
 * warming up" apart from "sitting in a backlog". The wire shape is
 * unchanged.
 *
 * Precedence:
 *   1. SSE terminal frame observed in this session
 *   2. Polled terminal status from /api/jobs (so a stale liveStatus =
 *      "running" cannot mask a terminal that arrived after the SSE
 *      connection dropped)
 *   3. SSE-derived liveStatus = "running" (i.e. training.started seen)
 *   4. Synthetic `provisioning` when the job is queued AND either the
 *      event stream is open without a training.started yet, or
 *      createdAt is within `recentMs`
 *   5. Polled non-terminal status, default queued
 */
export function computeDisplayStatus(input: ComputeDisplayStatusInput): DisplayStatus {
  const {
    job,
    liveStatus,
    terminalStatus,
    eventStreamConnected,
    now,
    recentMs = DEFAULT_RECENT_MS,
  } = input;

  if (terminalStatus) return terminalStatus;

  if (
    job?.status === "completed" ||
    job?.status === "failed" ||
    job?.status === "cancelled"
  ) {
    return job.status;
  }

  if (liveStatus === "running") return "running";

  const isQueued = !job || job.status === "queued";
  if (isQueued) {
    if (eventStreamConnected) return "provisioning";
    if (job?.createdAt && typeof now === "number") {
      const created = Date.parse(job.createdAt);
      if (Number.isFinite(created) && now - created < recentMs) {
        return "provisioning";
      }
    }
  }

  return job?.status ?? "queued";
}
