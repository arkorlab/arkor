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

  useEffect(() => {
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
    }

    const es = openJobEvents(jobId);
    es.addEventListener("training.started", (ev: MessageEvent) => {
      pushEvent("training.started", ev.data);
    });
    es.addEventListener("training.log", (ev: MessageEvent) => {
      pushEvent("training.log", ev.data);
      try {
        const d = JSON.parse(ev.data) as { step: number; loss?: number | null };
        setPoints((prev) => [
          ...prev,
          { step: d.step, loss: d.loss ?? null },
        ]);
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

  // Live duration ticker while the job is running.
  const isRunning = job?.status === "running" && !terminal;
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  const status = terminal?.status ?? job?.status ?? "queued";
  const duration = computeDuration(job, terminal, now);

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
      value: job?.startedAt ? formatAbsoluteTime(job.startedAt) : "—",
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
  terminal: { status: string } | null,
  now: number,
): number | null {
  if (!job?.startedAt) return null;
  const start = Date.parse(job.startedAt);
  if (Number.isNaN(start)) return null;
  if (job.completedAt) {
    return Math.max(0, Date.parse(job.completedAt) - start);
  }
  if (terminal) return Math.max(0, now - start);
  if (job.status === "running") return Math.max(0, now - start);
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
