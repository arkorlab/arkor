import { useEffect, useRef, useState } from "react";
import {
  fetchManifest,
  streamTraining,
  type ManifestResult,
} from "../lib/api";
import { track } from "../lib/telemetry";

export function RunTraining() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [manifest, setManifest] = useState<ManifestResult | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchManifest()
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setManifest({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run() {
    const start = Date.now();
    track("studio_train_form_submitted", {
      has_trainer: Boolean(trainer),
    });
    setRunning(true);
    setLog("");
    let streamStarted = false;
    let exitCode: number | null = null;
    // Server writes `\n---\nexit=${code}\n` as the last enqueue, but the
    // body reader can split that byte sequence anywhere, so a per-chunk
    // regex on the marker can miss when the split lands inside it. Hold a
    // small rolling tail across chunks and require the trailing `\n` so we
    // only commit once the full digit run has arrived.
    let exitTail = "";
    const EXIT_TAIL_KEEP = 64;
    try {
      await streamTraining((chunk) => {
        if (!streamStarted) {
          streamStarted = true;
          track("studio_train_subprocess_started", {});
        }
        if (exitCode === null) {
          exitTail = (exitTail + chunk).slice(-EXIT_TAIL_KEEP);
          const match = exitTail.match(/\nexit=(-?\d+)\n/);
          if (match) exitCode = Number(match[1]);
        }
        setLog((prev) => {
          const next = prev + chunk;
          queueMicrotask(() => {
            if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
          });
          return next;
        });
      });
      track("studio_train_subprocess_finished", {
        exit_code: exitCode,
        duration_ms: Date.now() - start,
      });
    } catch (err) {
      setLog((prev) => prev + `\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
      track("studio_train_subprocess_finished", {
        exit_code: null,
        duration_ms: Date.now() - start,
      });
    } finally {
      setRunning(false);
    }
  }

  const trainer =
    manifest && "trainer" in manifest ? manifest.trainer : null;
  const manifestError =
    manifest && "error" in manifest ? manifest.error : null;
  const hasTrainer = Boolean(trainer);

  const buttonLabel = running
    ? "Running…"
    : trainer
      ? `Run training: ${trainer.name}`
      : "Run training";

  return (
    <div className="run-training">
      {manifestError && (
        <p className="manifest-hint">
          Couldn't read manifest: {manifestError}
        </p>
      )}
      {manifest && !manifestError && !hasTrainer && (
        <p className="manifest-hint">
          No trainer in src/arkor/index.ts yet. Add{" "}
          <code>createTrainer(...)</code> and pass it to{" "}
          <code>createArkor</code>.
        </p>
      )}
      <button onClick={run} disabled={running || !hasTrainer}>
        {buttonLabel}
      </button>
      <pre ref={boxRef} className="log">
        {log || "Output will appear here."}
      </pre>
    </div>
  );
}
