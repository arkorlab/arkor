import { cn } from "../ui/cn";

export type Mode = "base" | "adapter";

export function ModelToggle({
  mode,
  onChange,
  disabled,
  adapterDisabled,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled?: boolean;
  adapterDisabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Model source"
      className="inline-flex h-9 items-center rounded-full border border-zinc-200 bg-zinc-50 p-1 text-[13px] dark:border-zinc-800 dark:bg-zinc-900"
    >
      <Segment
        active={mode === "base"}
        disabled={disabled}
        onClick={() => onChange("base")}
        label="Base model"
      />
      <Segment
        active={mode === "adapter"}
        disabled={disabled || adapterDisabled}
        onClick={() => onChange("adapter")}
        label="Adapter"
        title={
          adapterDisabled
            ? "Train a job first to chat with a custom adapter"
            : undefined
        }
      />
    </div>
  );
}

function Segment({
  active,
  disabled,
  onClick,
  label,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      // Use aria-disabled (not the native `disabled` attribute) so the
      // browser still fires hover events on the element and the `title`
      // tooltip explaining *why* it's disabled is reachable. We block
      // activation manually below.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={title}
      className={cn(
        "inline-flex h-7 items-center rounded-full px-3 font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/30",
        active
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
        disabled && "cursor-not-allowed opacity-50 hover:text-zinc-500 dark:hover:text-zinc-400",
      )}
    >
      {label}
    </button>
  );
}
