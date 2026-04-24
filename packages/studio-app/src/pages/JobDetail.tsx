import { useEffect, useState } from "react";
import { openJobEvents } from "../lib/api";

interface LogPoint {
  step: number;
  loss: number | null;
}

interface TerminalInfo {
  status: "completed" | "failed";
  error?: string;
  artifacts?: unknown[];
}

export function JobDetail({ jobId }: { jobId: string }) {
  const [events, setEvents] = useState<LogPoint[]>([]);
  const [status, setStatus] = useState<string>("waiting…");
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [rawTail, setRawTail] = useState<string[]>([]);

  useEffect(() => {
    const es = openJobEvents(jobId);
    function pushRaw(line: string) {
      setRawTail((prev) => [...prev.slice(-50), line]);
    }
    es.addEventListener("training.started", (ev: MessageEvent) => {
      setStatus("running");
      pushRaw(`[started] ${ev.data}`);
    });
    es.addEventListener("training.log", (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data) as {
          step: number;
          loss?: number | null;
        };
        setEvents((prev) => [
          ...prev,
          { step: d.step, loss: d.loss ?? null },
        ]);
        pushRaw(`[log] step=${d.step} loss=${d.loss ?? "—"}`);
      } catch {
        pushRaw(`[log] ${ev.data}`);
      }
    });
    es.addEventListener("checkpoint.saved", (ev: MessageEvent) => {
      pushRaw(`[checkpoint] ${ev.data}`);
    });
    es.addEventListener("training.completed", (ev: MessageEvent) => {
      setStatus("completed");
      try {
        const d = JSON.parse(ev.data) as { artifacts?: unknown[] };
        setTerminal({ status: "completed", artifacts: d.artifacts ?? [] });
      } catch {
        setTerminal({ status: "completed" });
      }
      pushRaw(`[completed] ${ev.data}`);
    });
    es.addEventListener("training.failed", (ev: MessageEvent) => {
      setStatus("failed");
      try {
        const d = JSON.parse(ev.data) as { error: string };
        setTerminal({ status: "failed", error: d.error });
      } catch {
        setTerminal({ status: "failed" });
      }
      pushRaw(`[failed] ${ev.data}`);
    });
    es.addEventListener("end", () => es.close());
    es.onerror = () => pushRaw("[stream error]");
    return () => es.close();
  }, [jobId]);

  return (
    <div className="job-detail">
      <a href="#/" className="back">
        ← back to jobs
      </a>
      <h2>
        Job <code>{jobId}</code>
      </h2>
      <p>
        Status: <span className={`status status-${status}`}>{status}</span>
      </p>
      {terminal?.status === "failed" && (
        <p className="error">error: {terminal.error ?? "unknown"}</p>
      )}
      {terminal?.status === "completed" && (
        <p className="muted">
          artifacts: {terminal.artifacts?.length ?? 0}
        </p>
      )}
      <LossChart points={events} />
      <h3>Events</h3>
      <pre className="log">{rawTail.join("\n") || "—"}</pre>
    </div>
  );
}

function LossChart({ points }: { points: LogPoint[] }) {
  if (points.length === 0) {
    return <p className="muted">No training.log events yet.</p>;
  }
  const numericLosses = points
    .map((p) => p.loss)
    .filter((v): v is number => typeof v === "number");
  if (numericLosses.length === 0) {
    return <p className="muted">No loss data yet.</p>;
  }
  const maxLoss = Math.max(...numericLosses);
  const minLoss = Math.min(...numericLosses);
  const span = Math.max(0.001, maxLoss - minLoss);
  const width = 640;
  const height = 200;
  const lastStep = points[points.length - 1]!.step || 1;

  const path = points
    .map((p, i) => {
      const x = (p.step / Math.max(lastStep, 1)) * width;
      const loss = p.loss ?? minLoss;
      const y = height - ((loss - minLoss) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
        <path d={path} fill="none" stroke="#60a5fa" strokeWidth={2} />
      </svg>
      <p className="muted">
        loss: {minLoss.toFixed(3)} → {maxLoss.toFixed(3)} · step: {lastStep}
      </p>
    </div>
  );
}
