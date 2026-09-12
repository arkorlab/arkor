import { cn } from "../ui/cn";
import { CopyButton } from "../ui/CopyButton";

import type { ReactNode } from "react";

export interface JobMetaItem {
  label: string;
  value: ReactNode;
  mono?: boolean;
  copy?: string;
}

export function JobMetaSidebar({ items }: { items: JobMetaItem[] }) {
  return (
    <dl className="divide-edge divide-y">
      {items.map((it, i) => (
        <div key={i} className="flex items-start justify-between gap-3 py-3">
          <dt className="text-fg-subtle shrink-0 text-xs font-medium tracking-wider uppercase">
            {it.label}
          </dt>
          <dd
            className={cn(
              "text-fg min-w-0 text-right text-sm break-all",
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
