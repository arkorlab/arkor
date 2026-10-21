import { useEffect, useRef, useState } from "react";

import { fetchManifest, streamTraining, type ManifestResult } from "../lib/api";

import { Play, StopCircle } from "./icons";
import { Button } from "./ui/Button";

// Cap retained log so a long-running job's stdout can't grow the
// in-memory buffer indefinitely. ~100 KB is roughly several thousand
// lines of trainer output, more than enough for the recent context
// the user actually wants to see while the job runs.
const MAX_LOG_LENGTH = 100_000;

function appendCapped(prev: string, chunk: string): string {
  const next = prev + chunk;
  return next.length > MAX_LOG_LENGTH ? next.slice(-MAX_LOG_LENGTH) : next;
}

export function RunTraining() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [manifest, setManifest] = useState<ManifestResult | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);
  // Tracked separately from the manifest poll so navigating away
  // from Overview mid-stream tears the training stream down without
  // touching the (always-running) manifest poll.
  const trainingAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => trainingAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Poll the manifest so trainers added to src/arkor/index.ts mid-
    // session start the Run-training button without a page reload.
    // Chained setTimeout (not setInterval) so a slow /api/manifest
    // can't pile up overlapping in-flight calls.
    async function tick() {
      try {
        const m = await fetchManifest();
        if (!cancelled) setManifest(m);
      } catch (err: unknown) {
        if (!cancelled) {
          setManifest({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => void tick(), 5000);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [log]);

  async function run() {
    setRunning(true);
    setLog("");
    const ac = new AbortController();
    trainingAbortRef.current?.abort();
    trainingAbortRef.current = ac;
    try {
      await streamTraining(
        (chunk) => {
          if (ac.signal.aborted) return;
          setLog((prev) => appendCapped(prev, chunk));
        },
        undefined,
        ac.signal,
      );
    } catch (err) {
      // Aborts are expected when the user navigates away mid-stream;
      // don't surface them as errors in the log.
      if (ac.signal.aborted) return;
      setLog((prev) =>
        appendCapped(
          prev,
          `\n[error] ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    } finally {
      if (trainingAbortRef.current === ac) trainingAbortRef.current = null;
      // Always release the running flag, including the user-initiated
      // abort path. setState on an already-unmounted component is a
      // no-op in React 18+, so the unmount-cleanup case handles itself.
      setRunning(false);
    }
  }

  function stop() {
    trainingAbortRef.current?.abort();
  }

  const trainer = manifest && "trainer" in manifest ? manifest.trainer : null;
  const manifestError = manifest && "error" in manifest ? manifest.error : null;
  const hasTrainer = Boolean(trainer);

  return (
    <div className="space-y-4">
      {manifestError ? (
        <div className="border-warn-edge bg-warn-surface text-warn-fg rounded-lg border px-3 py-2.5 text-sm">
          Couldn't read manifest: {manifestError}
        </div>
      ) : null}
      {manifest && !manifestError && !hasTrainer ? (
        <div className="border-edge bg-inset text-fg-muted rounded-lg border px-3 py-2.5 text-sm">
          No trainer in{" "}
          <code className="bg-surface text-fg rounded px-1 py-0.5 font-mono text-[12px]">
            src/arkor/index.ts
          </code>{" "}
          yet. Add{" "}
          <code className="text-fg font-mono text-[12px]">
            createTrainer(...)
          </code>{" "}
          and pass it to{" "}
          <code className="text-fg font-mono text-[12px]">createArkor</code>.
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-fg-muted text-sm">
          {trainer ? (
            <>
              Trainer{" "}
              <code className="bg-inset text-fg rounded px-1.5 py-0.5 font-mono text-[12px]">
                {trainer.name}
              </code>{" "}
              from{" "}
              <code className="bg-inset text-fg rounded px-1.5 py-0.5 font-mono text-[12px]">
                src/arkor/index.ts
              </code>
              .
            </>
          ) : (
            <>
              Executes{" "}
              <code className="bg-inset text-fg rounded px-1.5 py-0.5 font-mono text-[12px]">
                src/arkor/index.ts
              </code>{" "}
              and streams trainer output here.
            </>
          )}
        </div>
        <Button
          // While `running`, the same button doubles as the abort
          // affordance; clicking aborts the in-flight stream so the
          // visible StopCircle icon actually does what the user
          // expects. When idle, it kicks off a new run.
          onClick={running ? stop : run}
          disabled={!running && !hasTrainer}
          leadingIcon={running ? <StopCircle /> : <Play />}
        >
          {running
            ? "Stop training"
            : trainer
              ? `Run training: ${trainer.name}`
              : "Run training"}
        </Button>
      </div>

      {(running || log) && (
        <pre
          ref={boxRef}
          className="border-edge bg-inset text-fg max-h-72 overflow-y-auto rounded-lg border p-4 font-mono text-[12px] leading-relaxed"
        >
          {log || (running ? "Waiting for output…" : "")}
        </pre>
      )}
    </div>
  );
}
