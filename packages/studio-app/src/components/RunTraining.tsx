import { useEffect, useRef, useState } from "react";
import {
  fetchManifest,
  isHmrEnabled,
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
  // HMR auto-restart bookkeeping:
  //  - lastTrainFileRef: carries the same `file?` arg into the auto
  //    re-spawn.
  //  - restartPendingRef: latch the SSE listener trips ONLY when *this
  //    tab's* current child landed in `restartTargets`. Without the
  //    pid scope, a tab whose run was hot-swapped (other tab's child
  //    in `restartTargets`) would still latch on the broadcast and
  //    auto-spawn a duplicate job after its own run completes.
  //  - runningRef: short-circuit for tabs not running anything.
  //  - currentPidRef: the spawned child's pid for the run currently
  //    in flight, set from the `X-Arkor-Train-Pid` response header.
  //  - hotSwapTimerRef: id for the "hot-swapped" status auto-clear
  //    timer so unmount-during-flash doesn't leak (or trigger a
  //    setState-after-unmount warning).
  const lastTrainFileRef = useRef<string | undefined>(undefined);
  const restartPendingRef = useRef(false);
  const runningRef = useRef(false);
  const currentPidRef = useRef<number | null>(null);
  // Browser `window.setTimeout` returns a numeric handle, not Node's
  // `Timeout` object — explicit `number` so TS doesn't pick up the
  // Node typing from the global `setTimeout`.
  const hotSwapTimerRef = useRef<number | null>(null);
  // SSE events that arrived during the startup window — after `run()`
  // set `runningRef.current = true` but before `streamTraining`'s
  // `onSpawn` populated `currentPidRef`. The per-pid filter would
  // otherwise drop any HMR dispatch landing in this window because
  // `myPid === null`, leaving the user on stale code: a config-
  // changing rebuild fires immediately after the Run click → server
  // SIGTERMs the just-started child → exit reaches us → no auto-
  // restart latch. Buffer here, drain in `onSpawn` once we know our
  // pid so the per-pid decision can run retroactively. Cleared in
  // `run()`'s `finally` (and on unmount) so a failed spawn doesn't
  // leak entries into the next run.
  const pendingPreSpawnEventsRef = useRef<DevEvent[]>([]);
  // Grace window after the train stream closes during which the SSE
  // handler can still latch a *late* restart event onto our just-
  // exited child. The `/api/train` stream and `/api/dev/events` SSE
  // are independent connections — under the race where the child
  // exits before the matching `rebuild` event lands on the SSE
  // channel (fast child exit, network jitter), `run()`'s finally
  // would synchronously settle "no restart" and the user would be
  // left on stale code despite the server-side SIGTERM. This timer
  // defers the no-restart decision and keeps `currentPidRef` set so
  // the SSE handler can still match per-pid; if the late event
  // arrives within the window it sets `restartPendingRef` and the
  // timer's callback fires the auto-restart from there. The window
  // is short (a few hundred ms) — well under user perception for
  // the no-restart outcome but long enough to absorb realistic
  // cross-connection delivery skew.
  const restartGraceTimerRef = useRef<number | null>(null);
  // Tracks "is this React tree still mounted?". The HMR auto-restart
  // path schedules `queueMicrotask(() => run(...))` after the prior
  // run's `finally` — without this gate, navigating away during the
  // tiny window between scheduling and the microtask running would
  // fire a fresh `/api/train` POST from an unmounted view, spawning
  // an invisible cloud job the user can't see or stop.
  const isMountedRef = useRef(true);

  useEffect(() => {
    // Re-arm the mounted flag every time the effect (re-)runs.
    // React StrictMode (enabled in `main.tsx` for dev) intentionally
    // runs setup → cleanup → setup once on mount to surface
    // ordering bugs; without this re-arm the cleanup's
    // `isMountedRef.current = false` would persist into the second
    // setup, making the ref permanently false while the component
    // is actually mounted. The HMR auto-restart paths guarded by
    // `isMountedRef.current` would then silently no-op in every
    // Vite dev session even though they work fine in `vite build`
    // output (StrictMode's double-effect is a dev-only behaviour).
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Defense in depth: clearing the latch here means even if a
      // microtask snuck past the `isMountedRef` check (concurrent
      // edits to React's effect ordering, future refactors), it
      // still finds nothing pending.
      restartPendingRef.current = false;
      pendingPreSpawnEventsRef.current = [];
      trainingAbortRef.current?.abort();
      if (hotSwapTimerRef.current !== null) {
        clearTimeout(hotSwapTimerRef.current);
        hotSwapTimerRef.current = null;
      }
      if (restartGraceTimerRef.current !== null) {
        clearTimeout(restartGraceTimerRef.current);
        restartGraceTimerRef.current = null;
      }
    };
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

  // HMR: listen for rebuild notifications from `arkor dev` and refresh
  // the manifest. When a rebuild also early-stopped *this tab's*
  // training run, the server includes the spawned pid in
  // `restartTargets`; defer the auto re-invocation until the current
  // `streamTraining` resolves so we don't run two cloud jobs at once.
  //
  // Gated by `isHmrEnabled()` (server-injected `<meta>` flag) rather
  // than `import.meta.env.DEV`: the SPA is shipped via `vite build`
  // and served by `arkor dev` as static assets, so DEV is `false` in
  // every real session. The server-side flag is `true` exactly when
  // `arkor dev` wired in an HMR coordinator — i.e. when
  // `/api/dev/events` actually exists. Without this flag the
  // EventSource would either be dead in real dev sessions (DEV gate)
  // or retry forever against a 404 (no gate).
  useEffect(() => {
    if (!isHmrEnabled()) return;
    const es = openDevEvents();
    // Typed as `Event` (not `MessageEvent`) because the same handler
    // is registered for the `error` event, which EventSource fires
    // as a plain `Event` on connection failures (server crashed,
    // browser dropped the SSE) — those carry no `.data`. Custom
    // server-sent events (`event: ready` / `event: rebuild` / the
    // SSE `event: error` frame the HMR server emits) all arrive as
    // `MessageEvent` instances, so we narrow before reading
    // `.data`. EventSource will auto-retry connection failures, so
    // there's nothing to do for them other than not crash.
    const onMessage = (raw: Event) => {
      if (!(raw instanceof MessageEvent)) return;
      let payload: DevEvent;
      try {
        payload = JSON.parse(raw.data) as DevEvent;
      } catch {
        return;
      }
      if (payload.type === "error") {
        setManifest({ error: payload.message ?? "Build failed" });
        setHmrStatus("idle");
        // Cancel any pending HMR auto-restart latched from a
        // previous successful rebuild. Without this, a sequence
        // like (rebuild → restartPendingRef=true → user breaks
        // the source → error event → child eventually exits) would
        // hit `run()`'s finally branch, see the still-set latch,
        // and auto-restart from the **previous** artefact even
        // though the latest source state is broken — silent
        // stale-code background churn until the user notices.
        // Clearing here makes the user's broken-state edit the
        // source of truth: no auto-restart fires until the next
        // successful rebuild re-arms the latch.
        restartPendingRef.current = false;
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
      // Per-child decision based on the spawned pid: a single rebuild
      // can produce mixed outcomes (one child hot-swapped, another
      // restarted), and `payload.restart` / `payload.hotSwap` reflect
      // *aggregate* truth across all active children. Filter to "did
      // *my* child land in this bucket?" so a tab whose run was
      // hot-swapped doesn't latch onto a sibling tab's restart.
      const myPid = currentPidRef.current;
      // Pre-spawn race: if we've started a run but `onSpawn` hasn't
      // populated our pid yet, the dispatch result for our own child
      // would be silently ignored. Stash the payload and let
      // `onSpawn` re-run the per-pid decision once the pid arrives.
      if (myPid === null && runningRef.current) {
        pendingPreSpawnEventsRef.current.push(payload);
        return;
      }
      // Don't gate `myRestart` on `runningRef.current`: the
      // `/api/train` stream and `/api/dev/events` SSE channel are
      // independent connections, so a fast child exit can race the
      // SSE delivery and flip `runningRef` to false JUST BEFORE the
      // matching `rebuild` event lands here. Per-pid filtering via
      // `currentPidRef` is what scopes the latch to *this tab's*
      // child; `run()`'s finally keeps `currentPidRef` set during a
      // brief grace window after the train stream closes for
      // exactly this reason. Without dropping the `runningRef`
      // gate, post-exit restart events would silently no-op and
      // leave the tab on stale code.
      const myRestart =
        myPid !== null &&
        (payload.restartTargets?.some((t) => t.pid === myPid) ?? false);
      const myHotSwap =
        myPid !== null &&
        (payload.hotSwapTargets?.some((t) => t.pid === myPid) ?? false);
      if (myRestart) {
        // Training run is early-stopping; the active stream will
        // resolve once the next checkpoint lands and the subprocess
        // exits cleanly. The `finally` block of `run()` picks up the
        // pending flag and re-spawns with the same args.
        restartPendingRef.current = true;
        setHmrStatus("early-stopping");
      } else if (myHotSwap) {
        // Callbacks were swapped in place — the cloud-side run is
        // unaffected. Flash a brief "hot-swapped" indicator so users
        // know the new code is live. The previous timer (if any) is
        // cleared so two close-together rebuilds don't race for the
        // status reset.
        setHmrStatus("hot-swapped");
        if (hotSwapTimerRef.current !== null) {
          clearTimeout(hotSwapTimerRef.current);
        }
        hotSwapTimerRef.current = window.setTimeout(() => {
          setHmrStatus((s) => (s === "hot-swapped" ? "idle" : s));
          hotSwapTimerRef.current = null;
        }, 1500);
      } else {
        // Nothing pertaining to this tab's child — leave any in-
        // progress status spans alone but make sure stale "early-
        // stopping" / "restarting" labels from a prior run don't
        // linger past the next quiet rebuild.
        if (!runningRef.current) setHmrStatus("idle");
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
    // Reset the pid before each spawn so a stale value from a prior
    // run can't accidentally match a new HMR restart broadcast in the
    // window between this assignment and `streamTraining` invoking
    // `onSpawn`.
    currentPidRef.current = null;
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
        (pid) => {
          currentPidRef.current = pid;
          // Clear the "Restarting with updated code…" status as soon
          // as the new run starts spawning. Without this the label
          // stays pinned for the entire restarted run because
          // `setHmrStatus("restarting")` is set in the *prior* run's
          // `finally` and nothing else clears it. We only knock out
          // "restarting" specifically — "early-stopping" / "hot-
          // swapped" should land via their own state transitions.
          setHmrStatus((s) => (s === "restarting" ? "idle" : s));
          // Drain any HMR events that landed in the pre-spawn race
          // window. Apply the same per-pid decision retroactively now
          // that the pid is known. Restart wins over hot-swap (a
          // stale child got SIGTERM'd → must re-spawn), so collapse
          // the buffer's findings into a single decision rather than
          // dispatching every buffered event verbatim.
          const buffered = pendingPreSpawnEventsRef.current;
          pendingPreSpawnEventsRef.current = [];
          let restartHit = false;
          let hotSwapHit = false;
          for (const ev of buffered) {
            if (ev.restartTargets?.some((t) => t.pid === pid)) {
              restartHit = true;
              break;
            }
            if (ev.hotSwapTargets?.some((t) => t.pid === pid)) {
              hotSwapHit = true;
            }
          }
          if (restartHit) {
            restartPendingRef.current = true;
            setHmrStatus("early-stopping");
          } else if (hotSwapHit) {
            setHmrStatus("hot-swapped");
            if (hotSwapTimerRef.current !== null) {
              clearTimeout(hotSwapTimerRef.current);
            }
            hotSwapTimerRef.current = window.setTimeout(() => {
              setHmrStatus((s) => (s === "hot-swapped" ? "idle" : s));
              hotSwapTimerRef.current = null;
            }, 1500);
          }
        },
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
      // DO NOT null `currentPidRef` here — the SSE handler needs to
      // be able to match per-pid during the post-exit grace window
      // below to catch a `rebuild` event that races behind the
      // train stream's close on the separate connection. Captured
      // here so the grace timer can detect "a new run started
      // during the window" by comparing the current ref against
      // `pidAtExit` and skipping its cleanup in that case.
      const pidAtExit = currentPidRef.current;
      // Drop any pre-spawn buffer entries that survived a failed
      // run (spawn errored before `onSpawn` could drain). Without
      // this they'd be carried into the next run and falsely match
      // the new pid only by luck.
      pendingPreSpawnEventsRef.current = [];
      if (trainingAbortRef.current === ac) trainingAbortRef.current = null;
      // Always release the running flag, including the user-initiated
      // abort path. setState on an already-unmounted component is a
      // no-op in React 18+, so the unmount-cleanup case handles itself.
      setRunning(false);

      if (ac.signal.aborted) {
        // User Stop wins over any pending or in-flight HMR restart —
        // clear everything synchronously and skip the grace window
        // so the tab really settles instead of bouncing back up.
        restartPendingRef.current = false;
        currentPidRef.current = null;
        setHmrStatus("idle");
        if (restartGraceTimerRef.current !== null) {
          clearTimeout(restartGraceTimerRef.current);
          restartGraceTimerRef.current = null;
        }
        return;
      }

      if (restartPendingRef.current) {
        // Fast path: SSE event already landed before exit. Fire the
        // restart synchronously without waiting for the grace
        // window so the common case has no perceptible delay.
        restartPendingRef.current = false;
        currentPidRef.current = null;
        setHmrStatus("restarting");
        const fileForRestart = lastTrainFileRef.current;
        queueMicrotask(() => {
          // Don't auto-spawn a fresh /api/train request from an
          // unmounted view — the user navigated away in the small
          // window between scheduling and running this microtask, so
          // their intent was "stop interacting with this view", not
          // "kick off another cloud job invisibly". The unmount
          // cleanup also clears `restartPendingRef` defensively.
          if (!isMountedRef.current) return;
          void run(fileForRestart);
        });
        return;
      }

      // Slow path: SSE rebuild event might still be in flight on a
      // separate connection. Defer the "no restart" decision so the
      // SSE handler has time to land and flip `restartPendingRef`.
      // `currentPidRef` stays set for the grace window so that
      // late event can still match per-pid.
      if (restartGraceTimerRef.current !== null) {
        clearTimeout(restartGraceTimerRef.current);
      }
      restartGraceTimerRef.current = window.setTimeout(() => {
        restartGraceTimerRef.current = null;
        // A new run started during the window (overwrote the pid).
        // Leave its lifecycle alone — its own finally will manage
        // the cleanup eventually.
        if (currentPidRef.current !== pidAtExit) return;
        currentPidRef.current = null;
        if (!isMountedRef.current) return;
        if (restartPendingRef.current) {
          restartPendingRef.current = false;
          setHmrStatus("restarting");
          const fileForRestart = lastTrainFileRef.current;
          void run(fileForRestart);
        } else {
          setHmrStatus("idle");
        }
      }, 250);
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
