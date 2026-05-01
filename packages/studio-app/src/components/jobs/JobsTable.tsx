import type { Job } from "../../lib/api";
import { formatDuration, truncateMiddle } from "../../lib/format";
import { RelativeTime } from "../ui/RelativeTime";
import { StatusBadge } from "../ui/StatusBadge";

function jobDurationMs(job: Job): number | null {
  if (!job.startedAt) return null;
  const end = job.completedAt ?? new Date().toISOString();
  const start = Date.parse(job.startedAt);
  const finish = Date.parse(end);
  if (Number.isNaN(start) || Number.isNaN(finish)) return null;
  return Math.max(0, finish - start);
}

export function JobsTable({
  jobs,
  compact = false,
}: {
  jobs: Job[];
  compact?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
            <th className="px-6 py-2.5 font-medium">Status</th>
            <th className="px-6 py-2.5 font-medium">Name</th>
            {!compact && <th className="px-6 py-2.5 font-medium">Duration</th>}
            <th className="px-6 py-2.5 font-medium">Created</th>
            <th className="px-6 py-2.5 font-medium">ID</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const ms = jobDurationMs(j);
            return (
              <tr
                key={j.id}
                className="group relative border-t border-zinc-100 transition-colors hover:bg-zinc-50 focus-within:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/60 dark:focus-within:bg-zinc-900/60"
              >
                <td className="px-6 py-3.5 align-middle">
                  <StatusBadge status={j.status} size="sm" />
                </td>
                <td className="px-6 py-3.5 align-middle">
                  {/*
                   * Stretched link: a single accessible <a> per row
                   * carries the navigation and the keyboard focus stop;
                   * its ::before is positioned absolute, which (because
                   * the <a> is static) resolves against the closest
                   * positioned ancestor — the <tr> with `relative` —
                   * extending the click target across the whole row.
                   */}
                  <a
                    href={`#/jobs/${j.id}`}
                    className="font-medium text-zinc-900 group-hover:text-teal-700 before:absolute before:inset-0 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500/40 dark:text-zinc-100 dark:group-hover:text-teal-300"
                  >
                    {j.name}
                  </a>
                </td>
                {!compact && (
                  <td className="px-6 py-3.5 align-middle text-zinc-500 dark:text-zinc-400 tabular-nums">
                    {ms === null ? "—" : formatDuration(ms)}
                  </td>
                )}
                <td className="px-6 py-3.5 align-middle text-zinc-500 dark:text-zinc-400">
                  <RelativeTime iso={j.createdAt} />
                </td>
                <td className="px-6 py-3.5 align-middle">
                  <code className="font-mono text-[12px] text-zinc-500 dark:text-zinc-500">
                    {truncateMiddle(j.id, 6, 4)}
                  </code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
