import {
  formatDuration,
  NO_VALUE_PLACEHOLDER,
  truncateMiddle,
} from "../../lib/format";
import { RelativeTime } from "../ui/RelativeTime";
import { StatusBadge } from "../ui/StatusBadge";

import type { Job } from "../../lib/api";

function jobDurationMs(job: Job): number | null {
  if (!job.startedAt) return null;
  const start = Date.parse(job.startedAt);
  if (Number.isNaN(start)) return null;
  if (job.completedAt) {
    const finish = Date.parse(job.completedAt);
    if (Number.isNaN(finish)) return null;
    return Math.max(0, finish - start);
  }
  // Only tick "now" against running jobs. Terminal statuses without a
  // completedAt (e.g. failed / cancelled where the server didn't
  // record the timestamp) shouldn't keep climbing on every render;
  // that would mislead the table reader.
  if (job.status !== "running") return null;
  return Math.max(0, Date.now() - start);
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
          <tr className="text-fg-subtle text-left text-[11px] font-medium tracking-wider uppercase">
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
                className="group border-edge focus-within:bg-inset hover:bg-inset relative border-t transition-colors"
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
                   * positioned ancestor (the <tr> with `relative`),
                   * extending the click target across the whole row.
                   */}
                  <a
                    href={`#/jobs/${j.id}`}
                    className="text-fg focus-visible:ring-ring font-medium group-hover:underline before:absolute before:inset-0 before:content-[''] focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                  >
                    {j.name}
                  </a>
                </td>
                {!compact && (
                  <td className="text-fg-muted px-6 py-3.5 align-middle tabular-nums">
                    {ms === null ? NO_VALUE_PLACEHOLDER : formatDuration(ms)}
                  </td>
                )}
                <td className="text-fg-muted px-6 py-3.5 align-middle">
                  <RelativeTime iso={j.createdAt} />
                </td>
                <td className="px-6 py-3.5 align-middle">
                  <code className="text-fg-subtle font-mono text-[12px]">
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
