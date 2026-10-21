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
    <label className="border-edge-strong bg-surface text-fg focus-within:ring-ring hover:bg-inset relative inline-flex h-9 items-center gap-2 rounded-full border pr-2 pl-3 text-sm font-medium transition-colors focus-within:ring-2">
      <span className="text-fg-muted">Model</span>
      <span className="text-fg-subtle font-mono text-[12px]">·</span>
      <span className="font-mono text-[12px]">{value}</span>
      <ChevronDown className="text-fg-subtle" />
      <select
        aria-label="Base model"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as SupportedBaseModel)}
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent text-transparent opacity-0 disabled:cursor-not-allowed"
      >
        {SUPPORTED_BASE_MODELS.map((m) => (
          <option key={m} value={m} className="bg-surface text-fg">
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}
