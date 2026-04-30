import { useEffect, useRef, useState } from "react";
import type { Job } from "../../lib/api";
import { ChevronDown } from "../icons";
import { cn } from "../ui/cn";
import { truncateMiddle } from "../../lib/format";

export function AdapterPicker({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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

  const selected = jobs.find((j) => j.id === selectedId) ?? null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors",
          "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50",
          "dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40",
        )}
      >
        <span className="text-zinc-500 dark:text-zinc-400">Adapter</span>
        <span className="font-mono text-[12px] text-zinc-400 dark:text-zinc-600">
          ·
        </span>
        {selected ? (
          <>
            <span className="max-w-[200px] truncate">{selected.name}</span>
            <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
              {truncateMiddle(selected.id, 4, 4)}
            </span>
          </>
        ) : (
          <span className="text-zinc-400 dark:text-zinc-600">Select…</span>
        )}
        <ChevronDown className="text-zinc-400 dark:text-zinc-500" />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-full z-20 mt-2 max-h-72 min-w-[280px] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          {jobs.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No completed jobs yet.
            </div>
          ) : (
            jobs.map((j) => {
              const active = j.id === selectedId;
              return (
                <button
                  key={j.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onSelect(j.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm",
                    active
                      ? "bg-teal-50 text-teal-900 dark:bg-teal-400/10 dark:text-teal-100"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-900",
                  )}
                >
                  <span className="min-w-0 truncate">{j.name}</span>
                  <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                    {truncateMiddle(j.id, 4, 4)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
