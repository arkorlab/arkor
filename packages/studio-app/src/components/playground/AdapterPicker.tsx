import type { Job } from "../../lib/api";
import { ChevronDown } from "../icons";
import { truncateMiddle } from "../../lib/format";

export function AdapterPicker({
  jobs,
  selectedId,
  onSelect,
  disabled,
}: {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const selected = jobs.find((j) => j.id === selectedId) ?? null;

  return (
    <label className="relative inline-flex h-9 items-center gap-2 rounded-full border border-zinc-200 bg-white pl-3 pr-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus-within:ring-2 focus-within:ring-teal-500/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900">
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
      <select
        aria-label="Adapter"
        value={selectedId ?? ""}
        disabled={disabled || jobs.length === 0}
        onChange={(e) => onSelect(e.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0 disabled:cursor-not-allowed"
      >
        {selectedId === null ? (
          <option value="" disabled>
            Select…
          </option>
        ) : null}
        {jobs.map((j) => (
          <option key={j.id} value={j.id} className="bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            {j.name} ({truncateMiddle(j.id, 4, 4)})
          </option>
        ))}
      </select>
    </label>
  );
}
