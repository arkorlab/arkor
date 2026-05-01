import { useEffect, useRef } from "react";
import { Sparkles } from "../icons";
import { cn } from "../ui/cn";

export interface ChatMessage {
  id: number;
  role: "system" | "user" | "assistant";
  content: string;
}

export function MessageList({
  messages,
  streaming,
}: {
  messages: ChatMessage[];
  streaming: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onScroll = () => {
      const slack = el.scrollHeight - el.clientHeight - el.scrollTop;
      stickRef.current = slack < 24;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickRef.current || !wrapRef.current) return;
    wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={wrapRef}
      className="flex-1 overflow-y-auto px-4 py-6 sm:px-8"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-zinc-900 px-4 py-2.5 text-sm text-white dark:bg-white dark:text-zinc-900">
                  {m.content}
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className="flex gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <Sparkles />
              </span>
              <div className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                {m.content}
                {streaming && isLast && m.role === "assistant" ? (
                  <span
                    aria-hidden
                    className={cn(
                      "ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 rounded-sm bg-teal-500",
                      "animate-pulse",
                    )}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
