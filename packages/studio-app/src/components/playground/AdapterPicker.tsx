import { truncateMiddle } from "../../lib/format";
import { ChevronDown } from "../icons";

import type { Job } from "../../lib/api";

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
    <label className="border-edge-strong bg-surface text-fg focus-within:ring-ring hover:bg-inset relative inline-flex h-9 items-center gap-2 rounded-full border pr-2 pl-3 text-sm font-medium transition-colors focus-within:ring-2">
      <span className="text-fg-muted">Adapter</span>
      <span className="text-fg-subtle font-mono text-[12px]">·</span>
      {selected ? (
        <>
          <span className="max-w-[200px] truncate">{selected.name}</span>
          <span className="text-fg-subtle font-mono text-[11px]">
            {truncateMiddle(selected.id, 4, 4)}
          </span>
        </>
      ) : (
        <span className="text-fg-subtle">Select…</span>
      )}
      <ChevronDown className="text-fg-subtle" />
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
          <option key={j.id} value={j.id} className="bg-surface text-fg">
            {j.name} ({truncateMiddle(j.id, 4, 4)})
          </option>
        ))}
      </select>
    </label>
  );
}
