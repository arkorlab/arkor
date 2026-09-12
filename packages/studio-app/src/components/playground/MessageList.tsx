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
    <div ref={wrapRef} className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="bg-accent text-on-accent max-w-[85%] rounded-2xl px-4 py-2.5 text-sm break-words whitespace-pre-wrap">
                  {m.content}
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className="flex gap-3">
              <span className="border-edge bg-inset text-fg-subtle mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border">
                <Sparkles />
              </span>
              <div className="text-fg min-w-0 flex-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
                {m.content}
                {streaming && isLast && m.role === "assistant" ? (
                  <span
                    aria-hidden
                    className={cn(
                      "bg-fg ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 rounded-sm",
                      "motion-safe:animate-pulse",
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
