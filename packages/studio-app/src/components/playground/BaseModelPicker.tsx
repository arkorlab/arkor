import {
  SUPPORTED_BASE_MODELS,
  type SupportedBaseModel,
} from "../../lib/baseModels";
import { ChevronDown } from "../icons";

export function BaseModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: SupportedBaseModel;
  onChange: (model: SupportedBaseModel) => void;
  disabled?: boolean;
}) {
  return (
    <label className="relative inline-flex h-9 items-center gap-2 rounded-full border border-zinc-200 bg-white pl-3 pr-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus-within:ring-2 focus-within:ring-teal-500/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900">
      <span className="text-zinc-500 dark:text-zinc-400">Model</span>
      <span className="font-mono text-[12px] text-zinc-400 dark:text-zinc-600">
        ·
      </span>
      <span className="font-mono text-[12px]">{value}</span>
      <ChevronDown className="text-zinc-400 dark:text-zinc-500" />
      <select
        aria-label="Base model"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as SupportedBaseModel)}
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0 disabled:cursor-not-allowed"
      >
        {SUPPORTED_BASE_MODELS.map((m) => (
          <option key={m} value={m} className="bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}
