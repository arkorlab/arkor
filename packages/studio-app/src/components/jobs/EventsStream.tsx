import { useEffect, useRef } from "react";
import { cn } from "../ui/cn";

export interface EventEntry {
  id: number;
  ts: number;
  event: string;
  message: string;
}

const EVENT_TONE: Record<string, string> = {
  "training.started": "text-teal-600 dark:text-teal-300",
  "training.log": "text-zinc-500 dark:text-zinc-500",
  "training.completed": "text-emerald-600 dark:text-emerald-300",
  "training.failed": "text-red-600 dark:text-red-300",
  "checkpoint.saved": "text-amber-600 dark:text-amber-300",
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
      className="max-h-[420px] overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50/60 font-mono text-[12px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      {events.length === 0 ? (
        <div className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
          Listening for events…
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-900/80">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-start gap-3 px-4 py-1.5">
              <span className="w-16 shrink-0 text-zinc-400 dark:text-zinc-600">
                {formatTime(ev.ts)}
              </span>
              <span
                className={cn(
                  "w-40 shrink-0 truncate",
                  EVENT_TONE[ev.event] ?? "text-zinc-500 dark:text-zinc-500",
                )}
              >
                {ev.event}
              </span>
              <span className="min-w-0 flex-1 break-words text-zinc-700 dark:text-zinc-300">
                {ev.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
