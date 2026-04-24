import { useRef, useState } from "react";
import { streamTraining } from "../lib/api";

export function RunTraining() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const boxRef = useRef<HTMLPreElement>(null);

  async function run() {
    setRunning(true);
    setLog("");
    try {
      await streamTraining((chunk) => {
        setLog((prev) => {
          const next = prev + chunk;
          queueMicrotask(() => {
            if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
          });
          return next;
        });
      });
    } catch (err) {
      setLog((prev) => prev + `\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="run-training">
      <button onClick={run} disabled={running}>
        {running ? "Running…" : "Run training (src/arkor/index.ts)"}
      </button>
      <pre ref={boxRef} className="log">
        {log || "Output will appear here."}
      </pre>
    </div>
  );
}
