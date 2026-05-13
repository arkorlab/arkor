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
  const [advanced, setAdvanced] = useState(false);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [terminal, setTerminal] = useState<{
    status: "completed" | "failed";
    error?: string;
    artifacts: number;
    completedAt?: string;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Chained setTimeout instead of setInterval so a slow /api/jobs
    // request can't pile up overlapping calls. SSE remains the source
    // of truth for live status; polling is just for completedAt /
    // config / etc that the SSE stream doesn't carry.
    async function tick() {
      try {
        const { jobs } = await fetchJobs();
        if (!cancelled) {
          setJob(jobs.find((j) => j.id === jobId) ?? null);
        }
      } catch {
        // ignore — events stream is the source of truth for live status
      } finally {
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    // Clear per-job state when navigating between jobs so events, loss
    // points, terminal status, advanced toggle, and event-id counter
    // don't leak across routes. Resetting `advanced` matters: leaving
    // it on would immediately start computing stats during the new
    // job's live stream the moment its first points arrive.
    setEvents([]);
    setPoints([]);
    setAdvanced(false);
    setTerminal(null);
    setEventErr(null);
    setLiveStatus(null);
    setLiveStartedAt(null);

    let counter = 0;

    // Each SSE frame's `data` is JSON; the listeners below all need
    // both the formatted message (for the events stream) and a typed
    // view of the payload (for chart points / status / completedAt /
    // etc). Parse once per frame and pass the result to `pushEvent`
    // so the formatter doesn't have to re-parse.
    function safeParse(data: string): unknown {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }

    function pushEvent(event: string, data: string, parsed: unknown) {
      const id = counter++;
      let message = data;
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (event === "training.log") {
          // Omit each `key=…` segment when the corresponding field is
          // missing/non-numeric so eval-only frames render cleanly as
          // `step=<n> evalLoss=…` instead of being padded with a noisy
          // `loss=—` placeholder. `Number.isFinite` additionally
          // rejects non-finite numerics — `JSON.parse` overflows
          // out-of-range exponent forms like `1e309` to `Infinity`
          // (RFC 8259 grammar can't express `NaN`, so it can't arrive
          // from the wire), and we keep the `NaN` rejection as cheap
          // defense for in-process computation. The
          // `typeof === "number"` precondition lets TypeScript narrow
          // `p.loss` / `p.evalLoss` from `unknown` (the
          // `Record<string, unknown>` cast above) so `.toFixed` is
          // called on a typed `number` without an `as` assertion.
          const lossPart =
            typeof p.loss === "number" && Number.isFinite(p.loss)
              ? ` loss=${p.loss.toFixed(4)}`
              : "";
          const evalPart =
            typeof p.evalLoss === "number" && Number.isFinite(p.evalLoss)
              ? ` evalLoss=${p.evalLoss.toFixed(4)}`
              : "";
          message = `step=${p.step ?? "—"}${lossPart}${evalPart}`;
        } else if (event === "training.failed") {
          message = String(p.error ?? "failed");
        } else if (event === "training.completed") {
          const n = Array.isArray(p.artifacts) ? p.artifacts.length : 0;
          message = `${n} artifact${n === 1 ? "" : "s"}`;
        } else if (event === "checkpoint.saved") {
          message = `step=${p.step ?? "—"}`;
        }
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
      const parsed = safeParse(ev.data);
      pushEvent("training.started", ev.data, parsed);
      // SSE is the source of truth for live status. Drive `liveStatus`
      // / `liveStartedAt` independently of `job` so the page reflects
      // "running" even when the SSE event lands before /api/jobs has
      // populated `job` (or when polling fails entirely).
      setLiveStatus("running");
      if (parsed && typeof parsed === "object") {
        const d = parsed as { timestamp?: string };
        if (d.timestamp) setLiveStartedAt((prev) => prev ?? d.timestamp!);
      }
    });
    es.addEventListener("training.log", (ev: MessageEvent) => {
      const parsed = safeParse(ev.data);
      pushEvent("training.log", ev.data, parsed);
      if (parsed && typeof parsed === "object") {
        const d = parsed as {
          step?: number;
          loss?: number | null;
          evalLoss?: number | null;
        };
        // Validate every numeric field with `typeof === "number"` first
        // so TypeScript narrows the union (`number | null | undefined`
        // for the loss fields, `number | undefined` for step) before
        // the `Number.isFinite` check, eliminating the need for `as
        // number` casts in the assignments below. The finite check
        // additionally rejects non-finite numerics so they don't
        // reach LossChart / stats.ts, which both assume finite inputs
        // (otherwise min/max/span and the rendered SVG paths would
        // be NaN-poisoned). `JSON.parse` overflows out-of-range
        // exponent forms like `1e309` to `Infinity`; `NaN` cannot be
        // expressed in valid JSON but is still rejected as cheap
        // defense for in-process computation.
        if (typeof d.step !== "number" || !Number.isFinite(d.step)) return;
        const step = d.step;
        const safeLoss =
          typeof d.loss === "number" && Number.isFinite(d.loss)
            ? d.loss
            : null;
        const safeEvalLoss =
          typeof d.evalLoss === "number" && Number.isFinite(d.evalLoss)
            ? d.evalLoss
            : null;
        // Skip frames that carry neither a numeric loss nor a numeric
        // evalLoss. LossChart's `unified` filter would drop them on
        // render anyway, but they'd still consume a `MAX_LOSS_POINTS`
        // retention slot here — a long stream of no-loss frames could
        // evict earlier real loss points and degrade chart/stats
        // fidelity.
        if (safeLoss === null && safeEvalLoss === null) return;
        // Cap retained points so long/high-step runs don't grow without
        // bound and slow LossChart re-renders. 2000 is well above the
        // chart's visual resolution at any reasonable width.
        setPoints((prev) => {
          const next = [
            ...prev,
            {
              step,
              loss: safeLoss,
              evalLoss: safeEvalLoss,
            },
          ];
          return next.length > MAX_LOSS_POINTS
            ? next.slice(next.length - MAX_LOSS_POINTS)
            : next;
        });
      }
    });
    es.addEventListener("checkpoint.saved", (ev: MessageEvent) => {
      pushEvent("checkpoint.saved", ev.data, safeParse(ev.data));
    });
    es.addEventListener("training.completed", (ev: MessageEvent) => {
      const parsed = safeParse(ev.data);
      pushEvent("training.completed", ev.data, parsed);
      // SSE payload carries the trainer-side completion timestamp; use
      // it so duration / "Completed" stay correct without depending on
      // the next /api/jobs poll.
      if (parsed && typeof parsed === "object") {
        const d = parsed as { artifacts?: unknown[]; timestamp?: string };
        setTerminal({
          status: "completed",
          artifacts: Array.isArray(d.artifacts) ? d.artifacts.length : 0,
          completedAt: d.timestamp,
        });
      } else {
        setTerminal({ status: "completed", artifacts: 0 });
      }
    });
    es.addEventListener("training.failed", (ev: MessageEvent) => {
      const parsed = safeParse(ev.data);
      pushEvent("training.failed", ev.data, parsed);
      if (parsed && typeof parsed === "object") {
        const d = parsed as { error?: string; timestamp?: string };
        setTerminal({
          status: "failed",
          error: d.error,
          artifacts: 0,
          completedAt: d.timestamp,
        });
      } else {
        setTerminal({ status: "failed", artifacts: 0 });
      }
    });
    es.addEventListener("end", () => es.close());
    es.onerror = () => setEventErr("Event stream interrupted.");
    return () => es.close();
  }, [jobId]);

  // Status precedence:
  //   1. SSE terminal frame (training.completed / training.failed) we
  //      observed in this session — most authoritative.
  //   2. Polled terminal status from /api/jobs — also authoritative,
  //      and crucially it preempts a stale `liveStatus = "running"`
  //      that can linger if the SSE stream dropped before the
  //      terminal frame arrived.
  //   3. SSE-derived `liveStatus` for the running phase, which lets
  //      us flip the UI to "running" before /api/jobs catches up.
  //   4. The polled non-terminal status, if anything.
  //   5. Default "queued".
  const polledIsTerminal =
    job?.status === "completed" ||
    job?.status === "failed" ||
    job?.status === "cancelled";
  const status: Job["status"] =
    terminal?.status ??
    (polledIsTerminal ? job!.status : (liveStatus ?? job?.status ?? "queued"));

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
      value: (() => {
        const at = job?.completedAt ?? terminal?.completedAt;
        return at ? formatAbsoluteTime(at) : "—";
      })(),
      mono: true,
    },
    {
      label: "Base model",
      value: getConfigString(job?.config, ["model"]) ?? "—",
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
                // Pre-select this job's adapter so the Playground opens
                // on the run the user was inspecting, not whichever
                // completed job happens to be first in the list.
                const params = new URLSearchParams({ adapter: jobId });
                window.location.hash = `#/playground?${params.toString()}`;
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
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <CardTitle>Loss curve</CardTitle>
                  <CardDescription>
                    Each <code className="font-mono">training.log</code> event
                    from the trainer. Hover to inspect a step.
                  </CardDescription>
                </div>
                <AdvancedToggle
                  enabled={advanced}
                  onChange={setAdvanced}
                />
              </div>
            </CardHeader>
            <CardContent>
              <LossChart points={points} advanced={advanced} />
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

function AdvancedToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Advanced metrics"
      onClick={() => onChange(!enabled)}
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[12px] font-medium text-zinc-600 transition-colors hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/30 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
          enabled
            ? "bg-teal-500"
            : "bg-zinc-300 dark:bg-zinc-700"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
      Advanced
    </button>
  );
}

function computeDuration(
  job: Job | null,
  liveStartedAt: string | null,
  terminal: { status: string; completedAt?: string } | null,
  now: number,
): number | null {
  // Prefer the polled startedAt, fall back to the SSE-derived timestamp
  // so the timer still ticks when /api/jobs hasn't returned yet.
  const startedAt = job?.startedAt ?? liveStartedAt;
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;

  // Prefer terminal end-times (polled `completedAt` first, then the
  // SSE-supplied one) so duration freezes the moment the job finishes
  // even if /api/jobs is lagging — otherwise the ticker would keep
  // climbing past completion until the next poll succeeds.
  const completedAt = job?.completedAt ?? terminal?.completedAt;
  if (completedAt) {
    const end = Date.parse(completedAt);
    if (Number.isNaN(end)) return null;
    return Math.max(0, end - start);
  }

  // If we know the job is terminal (SSE terminal frame OR polled
  // status reached completed/failed/cancelled) but we don't have a
  // `completedAt` to anchor against, render `—` rather than tick `now`
  // — otherwise a cancelled/failed job whose backend never recorded a
  // completion timestamp would show an ever-growing duration as if it
  // were still running.
  const polledIsTerminal =
    job?.status === "completed" ||
    job?.status === "failed" ||
    job?.status === "cancelled";
  if (terminal || polledIsTerminal) return null;

  // Running phase — tick `now`. Either the polled status is already
  // "running", or SSE flipped us live before /api/jobs caught up.
  if (job?.status === "running" || liveStartedAt) {
    return Math.max(0, now - start);
  }
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
  // The SDK / cloud-api wire shape is `config.datasetSource` (see
  // packages/arkor/src/core/types.ts: HuggingfaceDatasetSource |
  // BlobDatasetSource). Older or hand-rolled configs may use
  // `config.dataset`, so fall through to that for backward compat.
  const candidates: unknown[] = [config.datasetSource, config.dataset];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.type === "huggingface") {
      const name = typeof obj.name === "string" ? obj.name : null;
      if (!name) continue;
      const subset = typeof obj.subset === "string" ? obj.subset : null;
      const split = typeof obj.split === "string" ? obj.split : null;
      const suffix = [subset, split].filter(Boolean).join("/");
      return suffix ? `${name} (${suffix})` : name;
    }
    if (obj.type === "blob" && typeof obj.url === "string") return obj.url;
    // Best-effort fallback for older `config.dataset.source.{name,url}`.
    const source = obj.source as Record<string, unknown> | undefined;
    if (source) {
      if (typeof source.name === "string") return source.name;
      if (typeof source.url === "string") return source.url;
    }
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.url === "string") return obj.url;
  }
  return null;
}
