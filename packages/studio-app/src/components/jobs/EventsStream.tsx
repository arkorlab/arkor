import { useEffect, useRef } from "react";

import { cn } from "../ui/cn";

export interface EventEntry {
  id: number;
  ts: number;
  event: string;
  message: string;
}

// Lifecycle events are set apart by weight rather than hue; only a failure
// earns a colour.
const EVENT_TONE: Record<string, string> = {
  "training.started": "font-medium text-fg",
  "training.log": "text-fg-subtle",
  "training.completed": "font-medium text-fg",
  "training.failed": "font-medium text-danger-fg",
  "checkpoint.saved": "text-fg-muted",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function EventsStream({ events }: { events: EventEntry[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onScroll = () => {
      const slack = el.scrollHeight - el.clientHeight - el.scrollTop;
      stickRef.current = slack < 16;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickRef.current || !wrapRef.current) return;
    wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
  }, [events]);

  return (
    <div
      ref={wrapRef}
      className="border-edge bg-inset max-h-[420px] overflow-y-auto rounded-lg border font-mono text-[12px] leading-relaxed"
    >
      {events.length === 0 ? (
        <div className="text-fg-muted px-4 py-8 text-center">
          Listening for events…
        </div>
      ) : (
        <ul className="divide-edge divide-y">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-start gap-3 px-4 py-1.5">
              <span className="text-fg-subtle w-16 shrink-0">
                {formatTime(ev.ts)}
              </span>
              <span
                className={cn(
                  "w-40 shrink-0 truncate",
                  EVENT_TONE[ev.event] ?? "text-fg-subtle",
                )}
              >
                {ev.event}
              </span>
              <span className="text-fg-muted min-w-0 flex-1 break-words">
                {ev.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
