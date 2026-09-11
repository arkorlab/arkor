import { useEffect, useRef, type KeyboardEvent } from "react";

import { Send } from "../icons";
import { cn } from "../ui/cn";

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = "Send a message…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Ignore Enter while the IME is composing. `isComposing` alone is not
    // enough: in Safari `compositionend` fires before `keydown`, so the Enter
    // that commits a conversion arrives with `isComposing === false` and only
    // the legacy `keyCode === 229` sentinel still marks it as IME processing.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode 229 is the only cross-browser IME-composition sentinel; there is no non-deprecated equivalent
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  }

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div className="border-edge bg-canvas border-t px-4 py-4 sm:px-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSubmit();
        }}
        className="mx-auto max-w-2xl"
      >
        <div
          className={cn(
            "bg-surface flex items-end gap-2 rounded-2xl border p-2 shadow-sm transition-colors",
            "border-edge-strong focus-within:ring-ring focus-within:ring-2",
          )}
        >
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={placeholder}
            aria-label="Message"
            disabled={disabled}
            className="text-fg placeholder:text-fg-subtle max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm focus-visible:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
              canSend
                ? "bg-accent text-on-accent hover:bg-accent-hover"
                : "bg-inset text-fg-subtle",
            )}
          >
            <Send />
          </button>
        </div>
        <p className="text-fg-subtle mt-2 text-center text-[11px]">
          Enter to send · Shift+Enter for newline
        </p>
      </form>
    </div>
  );
}
