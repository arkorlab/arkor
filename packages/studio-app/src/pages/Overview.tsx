import { useEffect, useState, type ReactNode } from "react";
import { fetchJobs, type Job } from "../lib/api";
import { ArrowRight, BookOpen, Inbox, Sparkles } from "../components/icons";
import { JobsTable } from "../components/jobs/JobsTable";
import { RunTraining } from "../components/RunTraining";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Skeleton";

const RECENT_LIMIT = 5;

export function Overview() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Chained setTimeout instead of setInterval so a slow /api/jobs
    // (>5s) can't pile up overlapping in-flight requests; we only
    // schedule the next tick after the previous settle.
    async function tick() {
      try {
        const { jobs } = await fetchJobs();
        if (!cancelled) {
          setJobs(jobs);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  const recent = jobs?.slice(0, RECENT_LIMIT) ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Overview
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Run training, inspect jobs, and chat with your fine-tuned adapters.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run training</CardTitle>
          <CardDescription>
            Triggers your local trainer entry point and streams logs in real time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunTraining />
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          actions={
            <a
              href="#/jobs"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            >
              View all
              <ArrowRight width="14" height="14" />
            </a>
          }
        >
          <CardTitle>Recent jobs</CardTitle>
          <CardDescription>
            The {RECENT_LIMIT} most recent training runs in this project.
          </CardDescription>
        </CardHeader>
        {error ? (
          <CardContent>
            <p className="text-sm text-red-600 dark:text-red-400">
              Failed to load jobs: {error}
            </p>
          </CardContent>
        ) : recent === null ? (
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </CardContent>
        ) : recent.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title="No jobs yet"
            description="Run training above to create your first job."
          />
        ) : (
          <JobsTable jobs={recent} compact />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <QuickStartTile
          icon={<BookOpen />}
          title="Documentation"
          description="Framework primitives, callbacks, and deployment guides."
          href="https://arkor.ai"
          external
        />
        <QuickStartTile
          icon={<Sparkles />}
          title="Open the Playground"
          description="Chat with completed jobs and compare adapter checkpoints."
          href="#/playground"
        />
      </div>
    </div>
  );
}

function QuickStartTile({
  icon,
  title,
  description,
  href,
  external,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="group flex items-start gap-4 rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-600 transition-colors group-hover:bg-teal-50 group-hover:text-teal-600 group-hover:border-teal-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:group-hover:bg-teal-400/10 dark:group-hover:text-teal-300 dark:group-hover:border-teal-400/30">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
          <ArrowRight
            width="14"
            height="14"
            className="opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100"
          />
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      </div>
    </a>
  );
}
