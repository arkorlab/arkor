import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJobs, type Job } from "../lib/api";
import { Inbox, Refresh, Search } from "../components/icons";
import { JobsTable } from "../components/jobs/JobsTable";
import { Card, CardHeader, CardTitle, CardDescription } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { IconButton } from "../components/ui/IconButton";
import { Skeleton } from "../components/ui/Skeleton";

type StatusFilter = "all" | Job["status"];

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "queued", label: "Queued" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function JobsList() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  // True while a `load()` call is awaiting fetchJobs. Used to coalesce
  // a manual refresh click that lands while the polling tick is still
  // in flight (or vice versa) into a single request — without this,
  // two concurrent /api/jobs calls could finish out of order and an
  // older snapshot could overwrite a newer one in `setJobs`.
  const inFlightRef = useRef(false);

  // useCallback (with `[]` deps) makes this referentially stable across
  // renders so the polling effect below can list it as a dependency
  // without re-scheduling on every render. The body only touches
  // setters (which React guarantees stable) and refs, so an empty
  // dep array is genuinely safe.
  //
  // No alive/cancelled gate around the setState calls here: React 18+
  // silently no-ops setState on unmounted components, and an earlier
  // round's `aliveRef` flag was being toggled across StrictMode dev
  // re-mounts in a way that could drop a still-in-flight load's
  // results during the cleanup→remount window. The polling effect
  // below uses an effect-local `cancelled` to gate scheduling.
  // `manual` flips the visible spinner; the silent 5s polling tick
  // calls load() without it so the refresh icon doesn't pulse every
  // five seconds and look like the user just clicked it.
  const load = useCallback(async (manual = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (manual) setRefreshing(true);
    try {
      const { jobs } = await fetchJobs();
      setJobs(jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      if (manual) setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    // Effect-local `cancelled` so the first StrictMode pass's schedule
    // chain can't accidentally continue after the second pass starts.
    // Mirrors the pattern in Overview / JobDetail / RunTraining.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Chained setTimeout (not setInterval) so a slow /api/jobs request
    // can't accumulate overlapping in-flight calls. The same `load` is
    // wired to the manual refresh button.
    async function schedule() {
      await load();
      if (cancelled) return;
      timer = setTimeout(schedule, 5000);
    }
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [load]);

  const visible = useMemo(() => {
    if (!jobs) return null;
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (filter !== "all" && j.status !== filter) return false;
      if (!q) return true;
      return (
        j.name.toLowerCase().includes(q) || j.id.toLowerCase().includes(q)
      );
    });
  }, [jobs, query, filter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Jobs
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Every training run in this project. Auto-refreshes every 5 seconds.
        </p>
      </div>

      <Card>
        <CardHeader
          actions={
            <IconButton
              size="sm"
              label="Refresh"
              onClick={refresh}
              disabled={refreshing}
            >
              <Refresh
                className={refreshing ? "animate-spin opacity-60" : undefined}
              />
            </IconButton>
          }
        >
          <CardTitle>Training jobs</CardTitle>
          <CardDescription>
            Click a row to open the job detail and follow live events.
          </CardDescription>
        </CardHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
          <div className="relative flex-1 min-w-[180px]">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400 dark:text-zinc-500">
              <Search />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or ID…"
              aria-label="Search jobs by name or ID"
              className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:border-teal-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/30 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600"
            />
          </div>
          <div
            role="group"
            aria-label="Filter by status"
            className="flex flex-wrap items-center gap-1"
          >
            {STATUS_FILTERS.map((f) => {
              const active = filter === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(f.value)}
                  className={
                    active
                      ? "h-7 rounded-full bg-zinc-900 px-3 text-xs font-medium text-white dark:bg-white dark:text-zinc-900"
                      : "h-7 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  }
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <div className="px-6 py-4 text-sm text-red-600 dark:text-red-400">
            Failed to load jobs: {error}
          </div>
        ) : visible === null ? (
          <div className="space-y-3 px-6 py-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={
              jobs && jobs.length === 0
                ? "No jobs yet"
                : "No matches"
            }
            description={
              jobs && jobs.length === 0
                ? "Run training from Overview to create your first job."
                : "Try adjusting the filter or clearing the search."
            }
          />
        ) : (
          <JobsTable jobs={visible} />
        )}
      </Card>
    </div>
  );
}
