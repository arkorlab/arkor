import type { ReactNode } from "react";
import { CopyButton } from "../ui/CopyButton";
import { cn } from "../ui/cn";

export interface JobMetaItem {
  label: string;
  value: ReactNode;
  mono?: boolean;
  copy?: string;
}

export function JobMetaSidebar({ items }: { items: JobMetaItem[] }) {
  return (
    <dl className="divide-y divide-zinc-100 dark:divide-zinc-900">
      {items.map((it, i) => (
        <div key={i} className="flex items-start justify-between gap-3 py-3">
          <dt className="shrink-0 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
            {it.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 break-all text-right text-sm text-zinc-900 dark:text-zinc-100",
              it.mono && "font-mono text-[12px]",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {it.value}
              {it.copy ? <CopyButton value={it.copy} /> : null}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
