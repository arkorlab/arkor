import { useEffect, useRef, useState } from "react";
import {
  fetchManifest,
  openDevEvents,
  streamTraining,
  type DevEvent,
  type ManifestResult,
} from "../lib/api";
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
  const [hmrStatus, setHmrStatus] = useState<
    "idle" | "early-stopping" | "restarting" | "hot-swapped"
  >("idle");
  const boxRef = useRef<HTMLPreElement>(null);
  // Tracked separately from the manifest poll so navigating away
  // from Overview mid-stream tears the training stream down without
  // touching the (always-running) manifest poll.
  const trainingAbortRef = useRef<AbortController | null>(null);
  // HMR auto-restart bookkeeping. `lastTrainFileRef` carries the same
  // `file?` arg into the auto re-spawn; `restartPendingRef` is the
  // latch the SSE listener trips when the dev loop SIGTERMs the
  // current run for a config-mismatch rebuild; `runningRef` lets the
  // listener tell "is this tab the one running training?" apart from
  // a passive tab that should ignore the broadcast.
  const lastTrainFileRef = useRef<string | undefined>(undefined);
  const restartPendingRef = useRef(false);
  const runningRef = useRef(false);

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
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
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
        // `/api/dev/events` is a broadcast — every open Studio tab gets
        // this event. Only flip the auto-restart latch when *this* tab
        // is actually running a stream right now; otherwise a passive
        // tab would silently auto-spawn an extra job the next time the
        // user clicks Run training, doubling cloud spend.
        if (runningRef.current) {
          // Training run is early-stopping; the active stream will
          // resolve once the next checkpoint lands and the subprocess
          // exits cleanly. The `finally` block of `run()` picks up the
          // pending flag and re-spawns with the same args.
          restartPendingRef.current = true;
          setHmrStatus("early-stopping");
        } else {
          setHmrStatus("idle");
        }
      } else if (payload.hotSwap) {
        // Callbacks were swapped in place — the cloud-side run is
        // unaffected. Flash a brief "hot-swapped" indicator so users
        // know the new code is live.
        setHmrStatus("hot-swapped");
        window.setTimeout(() => {
          setHmrStatus((s) => (s === "hot-swapped" ? "idle" : s));
        }, 1500);
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

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [log]);

  async function run(file?: string): Promise<void> {
    runningRef.current = true;
    lastTrainFileRef.current = file;
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
        file,
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
      runningRef.current = false;
      if (trainingAbortRef.current === ac) trainingAbortRef.current = null;
      // Always release the running flag, including the user-initiated
      // abort path. setState on an already-unmounted component is a
      // no-op in React 18+, so the unmount-cleanup case handles itself.
      setRunning(false);
      if (restartPendingRef.current && !ac.signal.aborted) {
        // HMR-driven auto-restart: the dev loop SIGTERM'd the previous
        // run because the rebuild changed cloud-side config. Re-spawn
        // with the same args after a microtask so React commits the
        // `running=false` state first (otherwise the re-entry overlaps).
        restartPendingRef.current = false;
        setHmrStatus("restarting");
        queueMicrotask(() => {
          void run(lastTrainFileRef.current);
        });
      } else {
        // User-initiated abort takes precedence over a pending HMR
        // restart — clear the latch so a Stop click really stops.
        restartPendingRef.current = false;
        setHmrStatus("idle");
      }
    }
  }

  function stop() {
    // A user Stop click also cancels any pending HMR auto-restart so
    // the run finally settles instead of bouncing back up.
    restartPendingRef.current = false;
    trainingAbortRef.current?.abort();
  }

  const trainer = manifest && "trainer" in manifest ? manifest.trainer : null;
  const manifestError =
    manifest && "error" in manifest ? manifest.error : null;
  const hasTrainer = Boolean(trainer);

  return (
    <div className="space-y-4">
      {manifestError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
          Couldn't read manifest: {manifestError}
        </div>
      ) : null}
      {manifest && !manifestError && !hasTrainer ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No trainer in{" "}
          <code className="rounded bg-white px-1 py-0.5 font-mono text-[12px] text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
            src/arkor/index.ts
          </code>{" "}
          yet. Add{" "}
          <code className="font-mono text-[12px] text-zinc-700 dark:text-zinc-300">
            createTrainer(...)
          </code>{" "}
          and pass it to{" "}
          <code className="font-mono text-[12px] text-zinc-700 dark:text-zinc-300">
            createArkor
          </code>
          .
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          {trainer ? (
            <>
              Trainer{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                {trainer.name}
              </code>{" "}
              from{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                src/arkor/index.ts
              </code>
              .
            </>
          ) : (
            <>
              Executes{" "}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                src/arkor/index.ts
              </code>{" "}
              and streams trainer output here.
            </>
          )}
        </div>
        <Button
          // While `running`, the same button doubles as the abort
          // affordance — clicking aborts the in-flight stream so the
          // visible StopCircle icon actually does what the user
          // expects. When idle, it kicks off a new run.
          onClick={running ? stop : () => run(lastTrainFileRef.current)}
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

      {hmrStatus !== "idle" && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {hmrStatus === "early-stopping" && "Stopping at next checkpoint…"}
          {hmrStatus === "restarting" && "Restarting with updated code…"}
          {hmrStatus === "hot-swapped" &&
            "Callbacks hot-swapped — run continues."}
        </div>
      )}

      {(running || log) && (
        <pre
          ref={boxRef}
          className="max-h-72 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-[12px] leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-200"
        >
          {log || (running ? "Waiting for output…" : "")}
        </pre>
      )}
    </div>
  );
}
