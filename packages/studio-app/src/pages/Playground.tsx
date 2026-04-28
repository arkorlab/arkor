import { useEffect, useRef, useState } from "react";
import { fetchJobs, streamInferenceContent, type Job } from "../lib/api";
import {
  DEFAULT_BASE_MODEL,
  SUPPORTED_BASE_MODELS,
  type SupportedBaseModel,
} from "../lib/baseModels";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

type Mode = "base" | "adapter";

export function Playground() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [mode, setMode] = useState<Mode>("base");
  const [baseModel, setBaseModel] =
    useState<SupportedBaseModel>(DEFAULT_BASE_MODEL);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const responseRef = useRef<string>("");

  useEffect(() => {
    fetchJobs().then(({ jobs }) => {
      const completed = jobs.filter((j) => j.status === "completed");
      setJobs(completed);
      if (completed.length > 0) setSelectedJob(completed[0]!.id);
    });
  }, []);

  const canSend =
    !streaming &&
    input.trim().length > 0 &&
    (mode === "base" || (mode === "adapter" && selectedJob !== null));

  async function send() {
    if (!canSend) return;
    const userMsg: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);
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
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `[error] ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="playground">
      <h2>Playground</h2>
      <fieldset className="mode-select">
        <legend>Mode</legend>
        <label>
          <input
            type="radio"
            name="mode"
            value="base"
            checked={mode === "base"}
            onChange={() => setMode("base")}
            disabled={streaming}
          />
          Base model
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            value="adapter"
            checked={mode === "adapter"}
            onChange={() => setMode("adapter")}
            disabled={streaming}
          />
          Adapter
        </label>
      </fieldset>
      {mode === "base" ? (
        <label>
          Base model:
          <select
            value={baseModel}
            disabled={streaming}
            onChange={(e) => setBaseModel(e.target.value as SupportedBaseModel)}
          >
            {SUPPORTED_BASE_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      ) : jobs.length === 0 ? (
        <p className="muted">
          No completed jobs yet. Train one, or switch to <em>Base model</em>.
        </p>
      ) : (
        <label>
          Adapter:
          <select
            value={selectedJob ?? ""}
            disabled={streaming}
            onChange={(e) => setSelectedJob(e.target.value)}
          >
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name} ({j.id.slice(0, 8)})
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <span className="msg-role">{m.role}</span>
            <span className="msg-content">{m.content}</span>
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something…"
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
  );
}
