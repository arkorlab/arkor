import { useEffect, useRef, useState } from "react";
import {
  SUPPORTED_BASE_MODELS,
  type SupportedBaseModel,
} from "../../lib/baseModels";
import { ChevronDown } from "../icons";
import { cn } from "../ui/cn";

export function BaseModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: SupportedBaseModel;
  onChange: (model: SupportedBaseModel) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors",
          "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
          "dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <span className="text-zinc-500 dark:text-zinc-400">Model</span>
        <span className="font-mono text-[12px] text-zinc-400 dark:text-zinc-600">
          ·
        </span>
        <span className="font-mono text-[12px]">{value}</span>
        <ChevronDown className="text-zinc-400 dark:text-zinc-500" />
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-20 mt-2 min-w-[260px] overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          {SUPPORTED_BASE_MODELS.map((m) => {
            const active = m === value;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left",
                  active
                    ? "bg-teal-50 dark:bg-teal-400/10"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                )}
              >
                <span
                  className={cn(
                    "font-mono text-[12px]",
                    active
                      ? "text-teal-900 dark:text-teal-100"
                      : "text-zinc-700 dark:text-zinc-300",
                  )}
                >
                  {m}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
