import { cn } from "./cn";

import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="border-edge bg-inset text-fg-subtle mb-4 flex h-10 w-10 items-center justify-center rounded-lg border">
          {icon}
        </div>
      ) : null}
      <h3 className="text-fg text-sm font-semibold">{title}</h3>
      {description ? (
        <p className="text-fg-muted mt-1 max-w-sm text-sm">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
