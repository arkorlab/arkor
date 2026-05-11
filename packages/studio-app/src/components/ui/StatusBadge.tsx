import type { Job } from "../../lib/api";
import { cn } from "./cn";

type Status = Job["status"];

interface StatusBadgeProps {
  status: Status | string;
  size?: "sm" | "md";
  className?: string;
}

type Variant = { label: string; pill: string; dot: string; pulse: boolean };

const VARIANT: Record<Status | "provisioning", Variant> = {
  queued: {
    label: "Queued",
    pill: "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400",
    dot: "bg-zinc-400 dark:bg-zinc-500",
    pulse: false,
  },
  provisioning: {
    label: "Warming up GPU",
    pill: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300",
    dot: "bg-amber-500",
    pulse: true,
  },
  running: {
    label: "Running",
    pill: "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-400/30 dark:bg-teal-400/10 dark:text-teal-300",
    dot: "bg-teal-500",
    pulse: true,
  },
  completed: {
    label: "Completed",
    pill: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300",
    dot: "bg-emerald-500",
    pulse: false,
  },
  failed: {
    label: "Failed",
    pill: "border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300",
    dot: "bg-red-500",
    pulse: false,
  },
  cancelled: {
    label: "Cancelled",
    pill: "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400",
    dot: "bg-zinc-400 dark:bg-zinc-500",
    pulse: false,
  },
};

const FALLBACK = VARIANT.queued;

export function StatusBadge({ status, size = "md", className }: StatusBadgeProps) {
  const v = (VARIANT as Record<string, typeof FALLBACK>)[status] ?? {
    ...FALLBACK,
    label: status,
  };
  const sizing =
    size === "sm"
      ? "h-5 px-2 text-[11px] gap-1.5"
      : "h-6 px-2.5 text-xs gap-1.5";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-medium tracking-tight",
        sizing,
        v.pill,
        className,
      )}
    >
      <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
        {v.pulse ? (
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 animate-ping rounded-full opacity-75",
              v.dot,
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", v.dot)} />
      </span>
      {v.label}
    </span>
  );
}
