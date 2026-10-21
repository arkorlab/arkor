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
      className="border-edge bg-inset inline-flex h-9 items-center rounded-full border p-1 text-[13px]"
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
  const button = (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center rounded-full px-3 font-medium transition-colors",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        active ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
        disabled && "hover:text-fg-muted cursor-not-allowed opacity-50",
      )}
    >
      {label}
    </button>
  );
  // Wrap a real `disabled` button (which keeps it out of the tab order
  // and properly inert) in a tooltip-carrying span: most browsers
  // suppress hover events on the disabled button itself, but they
  // still bubble up to the wrapper, so the `title` hint stays
  // reachable.
  if (disabled && title) {
    return (
      <span title={title} className="inline-flex">
        {button}
      </span>
    );
  }
  return button;
}
