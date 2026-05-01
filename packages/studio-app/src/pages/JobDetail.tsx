import { useEffect, useState } from "react";
import { fetchJobs, openJobEvents, type Job } from "../lib/api";
import { ArrowLeft, Sparkles } from "../components/icons";
import {
  EventsStream,
  type EventEntry,
} from "../components/jobs/EventsStream";
import { LossChart, type LossPoint } from "../components/jobs/LossChart";
import {
  JobMetaSidebar,
  type JobMetaItem,
} from "../components/jobs/JobMetaSidebar";
import { Breadcrumb } from "../components/ui/Breadcrumb";
import { Button } from "../components/ui/Button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { StatusBadge } from "../components/ui/StatusBadge";
import { formatDuration, truncateMiddle } from "../lib/format";

const MAX_LOSS_POINTS = 2000;

export function JobDetail({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [points, setPoints] = useState<LossPoint[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [terminal, setTerminal] = useState<{
    status: "completed" | "failed";
    error?: string;
    artifacts: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [eventErr, setEventErr] = useState<string | null>(null);
  // SSE-driven status / startedAt held independently of `job` so that
  // `training.started` events arriving before /api/jobs returns can
  // still drive the visible status.
  const [liveStatus, setLiveStatus] = useState<Job["status"] | null>(null);
  const [liveStartedAt, setLiveStartedAt] = useState<string | null>(null);

  useEffect(() => {
    setJob(null);
    let cancelled = false;
    async function load() {
      try {
        const { jobs } = await fetchJobs();
        if (!cancelled) {
          setJob(jobs.find((j) => j.id === jobId) ?? null);
        }
      } catch {
        // ignore — events stream is the source of truth for live status
      }
    }
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [jobId]);

  useEffect(() => {
    // Clear per-job state when navigating between jobs so events, loss
    // points, terminal status, and event-id counter don't leak across
    // routes.
    setEvents([]);
    setPoints([]);
    setTerminal(null);
    setEventErr(null);
    setLiveStatus(null);
    setLiveStartedAt(null);

    let counter = 0;
    function pushEvent(event: string, data: string) {
      const id = counter++;
      let message = data;
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed === "object" && parsed !== null) {
          if (event === "training.log") {
            message = `step=${parsed.step ?? "—"} loss=${
              typeof parsed.loss === "number" ? parsed.loss.toFixed(4) : "—"
            }`;
          } else if (event === "training.failed") {
            message = String(parsed.error ?? "failed");
          } else if (event === "training.completed") {
            const n = Array.isArray(parsed.artifacts)
              ? parsed.artifacts.length
              : 0;
            message = `${n} artifact${n === 1 ? "" : "s"}`;
          } else if (event === "checkpoint.saved") {
            message = `step=${parsed.step ?? "—"}`;
          } else {
            message = data;
          }
        }
      } catch {
        // leave raw
      }
      setEvents((prev) => [
        ...prev.slice(-499),
        { id, ts: Date.now(), event, message },
      ]);
      // Any received frame means the EventSource is alive again — drop
      // any stale "stream interrupted" banner from the prior disconnect.
      setEventErr(null);
    }

    const es = openJobEvents(jobId);
    es.addEventListener("training.started", (ev: MessageEvent) => {
      pushEvent("training.started", ev.data);
      // SSE is the source of truth for live status. Drive `liveStatus`
      // / `liveStartedAt` independently of `job` so the page reflects
      // "running" even when the SSE event lands before /api/jobs has
      // populated `job` (or when polling fails entirely).
      setLiveStatus("running");
      try {
        const d = JSON.parse(ev.data) as { timestamp?: string };
        if (d.timestamp) setLiveStartedAt((prev) => prev ?? d.timestamp!);
      } catch {
        // ignore parse failures
      }
    });
    es.addEventListener("training.log", (ev: MessageEvent) => {
      pushEvent("training.log", ev.data);
      try {
        const d = JSON.parse(ev.data) as { step: number; loss?: number | null };
        // Cap retained points so long/high-step runs don't grow without
        // bound and slow LossChart re-renders. 2000 is well above the
        // chart's visual resolution at any reasonable width.
        setPoints((prev) => {
          const next = [...prev, { step: d.step, loss: d.loss ?? null }];
          return next.length > MAX_LOSS_POINTS
            ? next.slice(next.length - MAX_LOSS_POINTS)
            : next;
        });
      } catch {
        // ignore parse failures
      }
    });
    es.addEventListener("checkpoint.saved", (ev: MessageEvent) => {
      pushEvent("checkpoint.saved", ev.data);
    });
    es.addEventListener("training.completed", (ev: MessageEvent) => {
      pushEvent("training.completed", ev.data);
      try {
        const d = JSON.parse(ev.data) as { artifacts?: unknown[] };
        setTerminal({
          status: "completed",
          artifacts: Array.isArray(d.artifacts) ? d.artifacts.length : 0,
        });
      } catch {
        setTerminal({ status: "completed", artifacts: 0 });
      }
    });
    es.addEventListener("training.failed", (ev: MessageEvent) => {
      pushEvent("training.failed", ev.data);
      try {
        const d = JSON.parse(ev.data) as { error: string };
        setTerminal({ status: "failed", error: d.error, artifacts: 0 });
      } catch {
        setTerminal({ status: "failed", artifacts: 0 });
      }
    });
    es.addEventListener("end", () => es.close());
    es.onerror = () => setEventErr("Event stream interrupted.");
    return () => es.close();
  }, [jobId]);

  const status = terminal?.status ?? liveStatus ?? job?.status ?? "queued";

  // Live duration ticker while the job is running.
  const isRunning = status === "running" && !terminal;
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  const duration = computeDuration(job, liveStartedAt, terminal, now);

  const meta: JobMetaItem[] = [
    { label: "Status", value: <StatusBadge status={status} size="sm" /> },
    {
      label: "Duration",
      value: duration === null ? "—" : formatDuration(duration),
      mono: true,
    },
    {
      label: "Created",
      value: job?.createdAt ? formatAbsoluteTime(job.createdAt) : "—",
      mono: true,
    },
    {
      label: "Started",
      value: (() => {
        const at = job?.startedAt ?? liveStartedAt;
        return at ? formatAbsoluteTime(at) : "—";
      })(),
      mono: true,
    },
    {
      label: "Completed",
      value: job?.completedAt ? formatAbsoluteTime(job.completedAt) : "—",
      mono: true,
    },
    {
      label: "Base model",
      value: getConfigString(job?.config, ["model", "baseModel"]) ?? "—",
      mono: true,
    },
    {
      label: "Dataset",
      value: getDatasetLabel(job?.config) ?? "—",
      mono: true,
    },
    {
      label: "Artifacts",
      value: terminal ? terminal.artifacts : "—",
      mono: true,
    },
    {
      label: "Job ID",
      value: truncateMiddle(jobId, 8, 6),
      mono: true,
      copy: jobId,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <Breadcrumb
            items={[
              { label: "Jobs", href: "#/jobs" },
              { label: job?.name ?? truncateMiddle(jobId, 6, 4), mono: !job },
            ]}
          />
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {job?.name ?? "Job"}
            </h1>
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ArrowLeft />}
            onClick={() => {
              window.location.hash = "#/jobs";
            }}
          >
            Back to jobs
          </Button>
          {status === "completed" && (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Sparkles />}
              onClick={() => {
                window.location.hash = "#/playground";
              }}
            >
              Open in Playground
            </Button>
          )}
        </div>
      </div>

      {terminal?.status === "failed" && terminal.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300">
          <span className="font-medium">Job failed:</span> {terminal.error}
        </div>
      ) : null}
      {eventErr ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
          {eventErr}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Loss curve</CardTitle>
              <CardDescription>
                Each <code className="font-mono">training.log</code> event from
                the trainer. Hover to inspect a step.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LossChart points={points} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Events</CardTitle>
              <CardDescription>
                Live SSE feed. Stays scrolled to the latest event unless you
                scroll up manually.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EventsStream events={events} />
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <JobMetaSidebar items={meta} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function computeDuration(
  job: Job | null,
  liveStartedAt: string | null,
  terminal: { status: string } | null,
  now: number,
): number | null {
  // Prefer the polled startedAt, fall back to the SSE-derived timestamp
  // so the timer still ticks when /api/jobs hasn't returned yet.
  const startedAt = job?.startedAt ?? liveStartedAt;
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  if (job?.completedAt) {
    const end = Date.parse(job.completedAt);
    if (Number.isNaN(end)) return Math.max(0, now - start);
    return Math.max(0, end - start);
  }
  if (terminal) return Math.max(0, now - start);
  if (job?.status === "running") return Math.max(0, now - start);
  if (liveStartedAt) return Math.max(0, now - start);
  return null;
}

function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function getConfigString(
  config: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!config) return null;
  for (const key of keys) {
    const v = config[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function getDatasetLabel(
  config: Record<string, unknown> | undefined,
): string | null {
  if (!config) return null;
  const ds = config.dataset;
  if (!ds || typeof ds !== "object") return null;
  const obj = ds as Record<string, unknown>;
  const source = obj.source as Record<string, unknown> | undefined;
  if (source) {
    if (typeof source.name === "string") return source.name;
    if (typeof source.url === "string") return source.url;
  }
  if (typeof obj.name === "string") return obj.name;
  return null;
}
