import { useEffect, useRef, useState } from "react";
import {
  fetchManifest,
  streamTraining,
  type ManifestResult,
} from "../lib/api";
import { Play, StopCircle } from "./icons";
import { Button } from "./ui/Button";

export function RunTraining() {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [manifest, setManifest] = useState<ManifestResult | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const m = await fetchManifest();
        if (!cancelled) setManifest(m);
      } catch (err: unknown) {
        if (!cancelled) {
          setManifest({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    load();
    // Poll the manifest so trainers added to src/arkor/index.ts mid-
    // session start the Run-training button without a page reload.
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [log]);

  async function run() {
    setRunning(true);
    setLog("");
    try {
      await streamTraining((chunk) => {
        setLog((prev) => prev + chunk);
      });
    } catch (err) {
      setLog(
        (prev) =>
          prev +
          `\n[error] ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      setRunning(false);
    }
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
          onClick={run}
          disabled={running || !hasTrainer}
          leadingIcon={running ? <StopCircle /> : <Play />}
        >
          {running
            ? "Running…"
            : trainer
              ? `Run training: ${trainer.name}`
              : "Run training"}
        </Button>
      </div>

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
