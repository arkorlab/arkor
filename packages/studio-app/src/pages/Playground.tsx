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

export function Playground({
  initialAdapterId,
}: {
  /** Pre-select this completed-job id when the page mounts, e.g. when
   * navigating from a JobDetail page's "Open in Playground" button. The
   * route layer parses it from `#/playground?adapter=<id>`. */
  initialAdapterId?: string;
} = {}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  // If the caller pre-selected an adapter, start in adapter mode so
  // the user lands directly on the picker for that job rather than on
  // base-model chat.
  const [mode, setMode] = useState<Mode>(initialAdapterId ? "adapter" : "base");
  const [baseModel, setBaseModel] =
    useState<SupportedBaseModel>(DEFAULT_BASE_MODEL);
  const [selectedJob, setSelectedJob] = useState<string | null>(
    initialAdapterId ?? null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseRef = useRef<string>("");
  const messageIdRef = useRef(0);
  // Holds the AbortController for the in-flight inference stream so
  // unmount (or a manual mode/model switch) can tear it down.
  const inferenceAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchJobs()
      .then(({ jobs }) => {
        const completed = jobs.filter((j) => j.status === "completed");
        setJobs(completed);
        // Reconcile the current selection (which may have been seeded
        // from `initialAdapterId` via the URL) against what the server
        // actually has. If the URL pointed at a since-deleted run we'd
        // otherwise keep firing inference requests with that stale id;
        // fall back to the first completed job (or null if there are
        // none) so the AdapterPicker reflects reality.
        setSelectedJob((prev) => {
          if (prev && completed.some((j) => j.id === prev)) return prev;
          return completed[0]?.id ?? null;
        });
      })
      .catch((err: unknown) => {
        // Even on /api/jobs failure, drop into base-model mode so the
        // composer still works — only the Adapter segment depends on
        // having completed jobs to enumerate.
        setJobs([]);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  // Tear the inference stream down on unmount so navigating away
  // mid-stream doesn't leave the async loop running and writing into
  // an unmounted component.
  useEffect(() => {
    return () => inferenceAbortRef.current?.abort();
  }, []);

  const adapterDisabled = !jobs || jobs.length === 0;

  const canSend =
    !streaming &&
    input.trim().length > 0 &&
    (mode === "base" || (mode === "adapter" && selectedJob !== null));

  async function send() {
    if (!canSend) return;
    // Allocate stable ids up front so streaming fragments and the
    // catch-branch error replacement always target the same assistant
    // slot, independent of when React flushes the placeholder update.
    const userMsg: ChatMessage = {
      id: ++messageIdRef.current,
      role: "user",
      content: input,
    };
    const assistantId = ++messageIdRef.current;
    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setInput("");
    setStreaming(true);
    responseRef.current = "";

    function writeAssistant(content: string) {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, content } : m)),
      );
    }

    const ac = new AbortController();
    inferenceAbortRef.current?.abort();
    inferenceAbortRef.current = ac;

    try {
      const stream = streamInferenceContent(
        {
          ...(mode === "base"
            ? { baseModel }
            : { adapter: { kind: "final", jobId: selectedJob! } }),
          messages: [...messages, userMsg],
          stream: true,
        },
        ac.signal,
      );
      for await (const fragment of stream) {
        responseRef.current += fragment;
        writeAssistant(responseRef.current);
      }
    } catch (err) {
      // Aborts are expected when the user navigates away or switches
      // mode mid-stream; don't surface them as errors in the bubble.
      if (ac.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      writeAssistant(`[error] ${msg}`);
    } finally {
      if (inferenceAbortRef.current === ac) inferenceAbortRef.current = null;
      if (!ac.signal.aborted) setStreaming(false);
    }
  }

  function changeMode(next: Mode) {
    if (next === mode) return;
    inferenceAbortRef.current?.abort();
    setStreaming(false);
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
              disabled={streaming}
            />
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300">
          Failed to load jobs: {error}
        </div>
      ) : null}

      {/* Adapter mode while jobs is still loading is reachable when
          we mount with `initialAdapterId` (e.g. via "Open in
          Playground" from JobDetail). Show a loading state in that
          case rather than the misleading "No completed jobs yet"
          empty state, which only applies once we know the list is
          really empty. */}
      {mode === "adapter" && jobs === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
          Loading jobs…
        </div>
      ) : mode === "adapter" && jobs?.length === 0 ? (
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
