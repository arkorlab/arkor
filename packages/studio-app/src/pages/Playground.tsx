import { useEffect, useRef, useState } from "react";
import { fetchJobs, streamInferenceContent, type Job } from "../lib/api";
import {
  DEFAULT_BASE_MODEL,
  type SupportedBaseModel,
} from "../lib/baseModels";
import { Sparkles } from "../components/icons";
import { AdapterPicker } from "../components/playground/AdapterPicker";
import { BaseModelPicker } from "../components/playground/BaseModelPicker";
import {
  ModelToggle,
  type Mode,
} from "../components/playground/ModelToggle";
import {
  MessageList,
  type ChatMessage,
} from "../components/playground/MessageList";
import { Composer } from "../components/playground/Composer";
import { EmptyState } from "../components/ui/EmptyState";

export function Playground() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [mode, setMode] = useState<Mode>("base");
  const [baseModel, setBaseModel] =
    useState<SupportedBaseModel>(DEFAULT_BASE_MODEL);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseRef = useRef<string>("");

  useEffect(() => {
    fetchJobs()
      .then(({ jobs }) => {
        const completed = jobs.filter((j) => j.status === "completed");
        setJobs(completed);
        if (completed.length > 0 && !selectedJob) {
          setSelectedJob(completed[0]!.id);
        }
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adapterDisabled = !jobs || jobs.length === 0;

  const canSend =
    !streaming &&
    input.trim().length > 0 &&
    (mode === "base" || (mode === "adapter" && selectedJob !== null));

  async function send() {
    if (!canSend) return;
    const userMsg: ChatMessage = { role: "user", content: input };
    setMessages((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: "" },
    ]);
    setInput("");
    setStreaming(true);
    responseRef.current = "";

    try {
      const stream = streamInferenceContent({
        ...(mode === "base"
          ? { baseModel }
          : { adapter: { kind: "final", jobId: selectedJob! } }),
        messages: [...messages, userMsg],
        stream: true,
      });
      for await (const fragment of stream) {
        responseRef.current += fragment;
        const current = responseRef.current;
        setMessages((prev) => {
          const out = prev.slice();
          out[out.length - 1] = { role: "assistant", content: current };
          return out;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) => {
        const out = prev.slice();
        out[out.length - 1] = {
          role: "assistant",
          content: `[error] ${msg}`,
        };
        return out;
      });
    } finally {
      setStreaming(false);
    }
  }

  function changeMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setMessages([]);
  }

  return (
    <div className="flex h-[calc(100vh-9.5rem)] flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Playground
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {mode === "base"
              ? "Chat with a supported base model — no training run required."
              : "Chat with a completed adapter to verify behaviour."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModelToggle
            mode={mode}
            onChange={changeMode}
            disabled={streaming}
            adapterDisabled={adapterDisabled}
          />
          {mode === "base" ? (
            <BaseModelPicker
              value={baseModel}
              onChange={(m) => {
                setBaseModel(m);
                setMessages([]);
              }}
              disabled={streaming}
            />
          ) : jobs && jobs.length > 0 ? (
            <AdapterPicker
              jobs={jobs}
              selectedId={selectedJob}
              onSelect={(id) => {
                setSelectedJob(id);
                setMessages([]);
              }}
            />
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300">
          Failed to load jobs: {error}
        </div>
      ) : null}

      {jobs === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
          Loading…
        </div>
      ) : mode === "adapter" && adapterDisabled ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<Sparkles />}
            title="No completed jobs yet"
            description="Run training and let it complete to chat with the resulting adapter, or switch back to Base model."
          />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={<Sparkles />}
              title="Ready when you are"
              description={
                mode === "base"
                  ? "Send the first message below — responses stream from the base model."
                  : "Send the first message below — responses stream from your selected adapter."
              }
            />
          </div>
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={send}
            disabled={streaming}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col">
          <MessageList messages={messages} streaming={streaming} />
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={send}
            disabled={streaming}
          />
        </div>
      )}
    </div>
  );
}
