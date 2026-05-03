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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  }

  const canSend = !disabled && value.trim().length > 0;

  return (
    <div className="border-t border-zinc-200 bg-white px-4 py-4 sm:px-8 dark:border-zinc-800 dark:bg-zinc-950">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSubmit();
        }}
        className="mx-auto max-w-2xl"
      >
        <div
          className={cn(
            "flex items-end gap-2 rounded-2xl border bg-white p-2 shadow-sm transition-colors",
            "border-zinc-200 focus-within:border-teal-300 focus-within:ring-2 focus-within:ring-teal-500/20",
            "dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-teal-500/40",
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
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-none disabled:opacity-60 dark:text-zinc-100 dark:placeholder:text-zinc-600"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
              canSend
                ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600",
            )}
          >
            <Send />
          </button>
        </div>
        <p className="mt-2 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
          Enter to send · Shift+Enter for newline
        </p>
      </form>
    </div>
  );
}
