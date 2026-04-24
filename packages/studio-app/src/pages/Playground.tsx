import { useEffect, useRef, useState } from "react";
import { fetchJobs, type Job } from "../lib/api";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export function Playground() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const responseRef = useRef<string>("");

  useEffect(() => {
    fetchJobs().then(({ jobs }) => {
      const completed = jobs.filter((j) => j.status === "completed");
      setJobs(completed);
      if (completed.length > 0) setSelected(completed[0]!.id);
    });
  }, []);

  async function send() {
    if (!input.trim() || !selected) return;
    const userMsg: Message = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    responseRef.current = "";

    try {
      const body = {
        adapter: { kind: "final", jobId: selected },
        messages: [...messages, userMsg],
        stream: true,
      };
      const res = await fetch("/api/inference/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        responseRef.current += chunk;
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
      {jobs.length === 0 ? (
        <p className="muted">No completed jobs yet.</p>
      ) : (
        <>
          <label>
            Adapter:
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name} ({j.id.slice(0, 8)})
                </option>
              ))}
            </select>
          </label>
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
            <button type="submit" disabled={streaming || !input.trim()}>
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
}
