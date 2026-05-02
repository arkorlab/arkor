import { useEffect, useRef, useState } from "react";
import {
  fetchManifest,
  openDevEvents,
  streamTraining,
  type DevEvent,
  type ManifestResult,
} from "../lib/api";

export function RunTraining() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [manifest, setManifest] = useState<ManifestResult | null>(null);
  const [hmrStatus, setHmrStatus] = useState<
    "idle" | "rebuilding" | "early-stopping" | "restarting"
  >("idle");
  const boxRef = useRef<HTMLPreElement>(null);
  const lastTrainFileRef = useRef<string | undefined>(undefined);
  const restartPendingRef = useRef(false);
  const runningRef = useRef(false);

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

  // HMR: listen for rebuild notifications from `arkor dev` and refresh the
  // manifest. When a rebuild also early-stopped a running training run, the
  // server flags `restart: true`; defer the actual re-invocation until the
  // current `streamTraining` resolves so we don't run two cloud jobs at once.
  useEffect(() => {
    const es = openDevEvents();
    const onMessage = (raw: MessageEvent) => {
      let payload: DevEvent;
      try {
        payload = JSON.parse(raw.data) as DevEvent;
      } catch {
        return;
      }
      if (payload.type === "error") {
        setManifest({ error: payload.message ?? "Build failed" });
        setHmrStatus("idle");
        return;
      }
      // Always refresh the manifest on ready/rebuild.
      void fetchManifest()
        .then(setManifest)
        .catch((err: unknown) => {
          setManifest({
            error: err instanceof Error ? err.message : String(err),
          });
        });
      if (payload.restart) {
        // Training run is early-stopping; the active stream will resolve
        // once the next checkpoint lands and the subprocess exits cleanly.
        // The `finally` block of `run()` picks up the pending flag and
        // re-spawns with the same args.
        restartPendingRef.current = true;
        setHmrStatus(runningRef.current ? "early-stopping" : "idle");
      } else {
        setHmrStatus("idle");
      }
    };
    es.addEventListener("ready", onMessage);
    es.addEventListener("rebuild", onMessage);
    es.addEventListener("error", onMessage);
    return () => {
      es.close();
    };
  }, []);

  async function run(file?: string): Promise<void> {
    runningRef.current = true;
    lastTrainFileRef.current = file;
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
      }, file);
    } catch (err) {
      setLog((prev) => prev + `\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      if (restartPendingRef.current) {
        restartPendingRef.current = false;
        setHmrStatus("restarting");
        // Re-spawn with the same args after a microtask so React commits the
        // `running=false` state first (otherwise the re-entry overlaps).
        queueMicrotask(() => {
          void run(lastTrainFileRef.current);
        });
      } else {
        setHmrStatus("idle");
      }
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
      <button onClick={() => run(lastTrainFileRef.current)} disabled={running || !hasTrainer}>
        {buttonLabel}
      </button>
      {hmrStatus === "early-stopping" && (
        <span className="hmr-status">Stopping at next checkpoint…</span>
      )}
      {hmrStatus === "restarting" && (
        <span className="hmr-status">Restarting with updated code…</span>
      )}
      <pre ref={boxRef} className="log">
        {log || "Output will appear here."}
      </pre>
    </div>
  );
}
