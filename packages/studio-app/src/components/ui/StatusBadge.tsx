import { cn } from "./cn";

import type { Job } from "../../lib/api";

type Status = Job["status"];

interface StatusBadgeProps {
  // `string & {}` is the TS-known trick that keeps autocomplete for the
  // five `Status` literals while still accepting any string at runtime
  // (the component renders unknown values via the fallback path below).
  // Plain `Status | string` would collapse to `string` and lose the
  // hints.
  status: Status | (string & {});
  size?: "sm" | "md";
  className?: string;
}

// Grayscale cannot lean on hue, so each state gets a distinct treatment:
// solid fill (completed), outline plus a pulsing dot (running), dashed
// outline (queued), muted fill (cancelled and anything unrecognised).
// `failed` is the one state that keeps a colour, per the danger-only policy
// in @arkor/ui.
const VARIANT: Record<
  Status,
  { label: string; pill: string; dot: string; pulse: boolean }
> = {
  queued: {
    label: "Queued",
    pill: "border-dashed border-edge-strong text-fg-muted",
    dot: "bg-fg-subtle",
    pulse: false,
  },
  running: {
    label: "Running",
    pill: "border-edge-strong bg-surface text-fg",
    dot: "bg-fg",
    pulse: true,
  },
  completed: {
    label: "Completed",
    pill: "border-transparent bg-accent text-on-accent",
    dot: "bg-on-accent",
    pulse: false,
  },
  failed: {
    label: "Failed",
    pill: "border-danger-edge bg-danger-surface text-danger-fg",
    dot: "bg-danger",
    pulse: false,
  },
  cancelled: {
    label: "Cancelled",
    pill: "border-transparent bg-inset text-fg-subtle",
    dot: "bg-fg-subtle",
    pulse: false,
  },
};

// An unrecognised status is inert, not waiting: the dashed `queued` outline
// would claim it is about to start.
const FALLBACK = VARIANT.cancelled;

export function StatusBadge({
  status,
  size = "md",
  className,
}: StatusBadgeProps) {
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
        <span
          className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", v.dot)}
        />
      </span>
      {v.label}
    </span>
  );
}
