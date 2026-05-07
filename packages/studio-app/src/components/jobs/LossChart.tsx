import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { summarize, type LossStats } from "../../lib/stats";

export interface LossPoint {
  step: number;
  loss: number | null;
  evalLoss?: number | null;
}

// One vertex on the chart. At least one of `loss` / `evalLoss` is
// non-null (the union pass below drops points that contribute
// neither), but either may be missing on a given step — the trainer
// is allowed to log eval-only or train-only frames.
type ChartPoint = {
  step: number;
  loss: number | null;
  evalLoss: number | null;
};

const HEIGHT = 240;
const PADDING = { top: 16, right: 16, bottom: 28, left: 48 };

const TRAIN_STROKE = "rgb(20 184 166)"; // teal-500
const EVAL_STROKE = "rgb(244 114 182)"; // pink-400

export function LossChart({
  points,
  advanced = false,
}: {
  points: LossPoint[];
  advanced?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<ChartPoint | null>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    // ResizeObserver is missing on older WebViews and on the SSR
    // pre-paint pass — degrade to a one-shot width read instead of
    // throwing on construction. The chart won't follow viewport
    // resizes there, but it still renders.
    if (typeof ResizeObserver === "undefined") {
      setWidth(Math.max(320, Math.floor(el.clientWidth || 640)));
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setWidth(Math.max(320, Math.floor(e.contentRect.width)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Unified series keyed by step. Building this from `points` (rather
  // than from the training-loss subset) is what lets eval-only frames
  // — `training.log` events that omit `loss` but carry `evalLoss` —
  // still appear in the eval line, legend, hover, and stats. Training
  // and eval series are derived from this union so both views agree
  // on which steps exist.
  const unified = useMemo<ChartPoint[]>(() => {
    const byStep = new Map<number, ChartPoint>();
    for (const p of points) {
      const hasLoss = typeof p.loss === "number";
      const hasEval = typeof p.evalLoss === "number";
      if (!hasLoss && !hasEval) continue;
      const existing = byStep.get(p.step);
      if (existing) {
        // Later frames at the same step (rare, but possible if a
        // trainer re-emits) win for whichever field they fill in.
        if (hasLoss) existing.loss = p.loss as number;
        if (hasEval) existing.evalLoss = p.evalLoss as number;
      } else {
        byStep.set(p.step, {
          step: p.step,
          loss: hasLoss ? (p.loss as number) : null,
          evalLoss: hasEval ? (p.evalLoss as number) : null,
        });
      }
    }
    return [...byStep.values()].sort((a, b) => a.step - b.step);
  }, [points]);

  const trainSeries = useMemo(
    () =>
      unified.filter(
        (p): p is ChartPoint & { loss: number } => typeof p.loss === "number",
      ),
    [unified],
  );

  const evalSeries = useMemo(
    () =>
      unified.filter(
        (p): p is ChartPoint & { evalLoss: number } =>
          typeof p.evalLoss === "number",
      ),
    [unified],
  );

  // Stats are gated on `advanced` so the per-`points`-update sort
  // baked into `summarize()` (for percentiles) doesn't run during a
  // live training stream when the panel isn't visible. Toggling
  // `advanced` on triggers a fresh useMemo evaluation.
  const trainStats = useMemo(
    () =>
      advanced && trainSeries.length > 0
        ? summarize(trainSeries.map((p) => p.loss))
        : null,
    [advanced, trainSeries],
  );
  const evalStats = useMemo(
    () =>
      advanced && evalSeries.length > 0
        ? summarize(evalSeries.map((p) => p.evalLoss))
        : null,
    [advanced, evalSeries],
  );

  if (unified.length === 0) {
    return (
      <div
        ref={wrapperRef}
        className="flex h-60 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
      >
        Waiting for training.log events…
      </div>
    );
  }

  // Range covers both series so eval-loss spikes don't get clipped when
  // they live outside the training-loss range.
  const allLossValues: number[] = [];
  for (const p of unified) {
    if (p.loss !== null) allLossValues.push(p.loss);
    if (p.evalLoss !== null) allLossValues.push(p.evalLoss);
  }
  const minLoss = Math.min(...allLossValues);
  const maxLoss = Math.max(...allLossValues);
  const span = Math.max(0.0001, maxLoss - minLoss);
  // Anchor the x-axis on the observed step range (firstStep..lastStep),
  // not 0..lastStep — otherwise a trainer that emits its first
  // training.log at step 1 leaves an empty gap from PADDING.left to
  // the line's first vertex and tick labels at the left edge would
  // disagree with where the line actually starts.
  const firstStep = unified[0]!.step;
  const lastStep = Math.max(firstStep + 1, unified[unified.length - 1]!.step);
  const xSpan = lastStep - firstStep;
  const innerW = Math.max(50, width - PADDING.left - PADDING.right);
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;

  function xFor(step: number) {
    return PADDING.left + ((step - firstStep) / xSpan) * innerW;
  }
  function yFor(loss: number) {
    return PADDING.top + (1 - (loss - minLoss) / span) * innerH;
  }

  const linePath = trainSeries
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${xFor(p.step).toFixed(2)},${yFor(p.loss).toFixed(2)}`,
    )
    .join(" ");
  const areaPath =
    trainSeries.length > 0
      ? `${linePath} L${xFor(trainSeries[trainSeries.length - 1]!.step).toFixed(2)},${PADDING.top + innerH} L${xFor(trainSeries[0]!.step).toFixed(2)},${PADDING.top + innerH} Z`
      : "";

  const evalPath =
    evalSeries.length > 0
      ? evalSeries
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${xFor(p.step).toFixed(2)},${yFor(p.evalLoss).toFixed(2)}`,
          )
          .join(" ")
      : "";

  const gridSteps = 4;
  const yTicks = Array.from({ length: gridSteps + 1 }).map((_, i) => {
    const t = i / gridSteps;
    const value = maxLoss - t * span;
    return { y: PADDING.top + t * innerH, value };
  });
  // De-dupe via Set so a small span (e.g. lastStep === 3 with
  // xTickCount === 6) doesn't render the same step number twice.
  const xTickCount = Math.min(6, unified.length);
  const xTicks = Array.from(
    new Set(
      Array.from({ length: xTickCount }).map((_, i) => {
        const t = xTickCount === 1 ? 0 : i / (xTickCount - 1);
        return Math.round(firstStep + t * xSpan);
      }),
    ),
  );

  function onMouseMove(e: MouseEvent<SVGRectElement>) {
    // The `<rect>` is already positioned at `x={PADDING.left}`, so its
    // bounding box origin in viewport coordinates already accounts for
    // the chart's left padding. `e.clientX - rect.left` gives a value
    // in [0, rect.width] = [0, innerW], so we divide by `rect.width`
    // directly. Subtracting PADDING.left here would double-shift and
    // make the right edge of the chart unreachable.
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width),
    );
    const targetStep = Math.round(firstStep + fraction * xSpan);
    // `unified` is sorted by step (see useMemo above) — binary search
    // for the insertion point and pick whichever neighbour is closer.
    // O(log n) vs the previous O(n) sweep that was running on every
    // mousemove against up to MAX_LOSS_POINTS=2000 entries.
    let lo = 0;
    let hi = unified.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (unified[mid]!.step < targetStep) lo = mid + 1;
      else hi = mid;
    }
    const candidate = unified[lo]!;
    const before = lo > 0 ? unified[lo - 1]! : candidate;
    const nearest =
      Math.abs(before.step - targetStep) <= Math.abs(candidate.step - targetStep)
        ? before
        : candidate;
    setHover(nearest);
  }

  // Tooltip y-anchor: prefer the training-loss vertex when present,
  // otherwise pin to the eval-loss vertex so eval-only steps still
  // get a sensibly-placed tooltip.
  const hoverAnchorLoss =
    hover === null
      ? 0
      : hover.loss !== null
        ? hover.loss
        : (hover.evalLoss as number);

  return (
    <div ref={wrapperRef} className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        className="block"
      >
        <defs>
          <linearGradient id="loss-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(45 212 191)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="rgb(45 212 191)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={`y-${i}`}>
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={t.y}
              y2={t.y}
              className="stroke-zinc-200 dark:stroke-zinc-800"
              strokeDasharray="2 4"
            />
            <text
              x={PADDING.left - 8}
              y={t.y}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-zinc-500 font-mono text-[10px] dark:fill-zinc-500"
            >
              {t.value.toFixed(3)}
            </text>
          </g>
        ))}

        {xTicks.map((step, i) => (
          <text
            key={`x-${i}`}
            x={xFor(step)}
            y={HEIGHT - 8}
            textAnchor="middle"
            className="fill-zinc-500 font-mono text-[10px] dark:fill-zinc-500"
          >
            {step}
          </text>
        ))}

        {areaPath ? <path d={areaPath} fill="url(#loss-area)" /> : null}
        {linePath ? (
          <path
            d={linePath}
            fill="none"
            stroke={TRAIN_STROKE}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}

        {evalPath ? (
          <path
            d={evalPath}
            fill="none"
            stroke={EVAL_STROKE}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="4 3"
          />
        ) : null}

        {evalSeries.map((p) => (
          <circle
            key={`eval-${p.step}`}
            cx={xFor(p.step)}
            cy={yFor(p.evalLoss)}
            r={2.5}
            fill={EVAL_STROKE}
          />
        ))}

        {hover ? (
          <g>
            <line
              x1={xFor(hover.step)}
              x2={xFor(hover.step)}
              y1={PADDING.top}
              y2={PADDING.top + innerH}
              className="stroke-zinc-300 dark:stroke-zinc-700"
              strokeDasharray="2 3"
            />
            {hover.loss !== null ? (
              <circle
                cx={xFor(hover.step)}
                cy={yFor(hover.loss)}
                r={3.5}
                fill="white"
                stroke={TRAIN_STROKE}
                strokeWidth={2}
              />
            ) : null}
            {hover.evalLoss !== null ? (
              <circle
                cx={xFor(hover.step)}
                cy={yFor(hover.evalLoss)}
                r={3.5}
                fill="white"
                stroke={EVAL_STROKE}
                strokeWidth={2}
              />
            ) : null}
          </g>
        ) : null}

        <rect
          x={PADDING.left}
          y={PADDING.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      <Legend
        hasTrain={trainSeries.length > 0}
        hasEval={evalSeries.length > 0}
      />

      {hover ? (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-mono shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          style={{
            left: xFor(hover.step),
            top: Math.max(0, yFor(hoverAnchorLoss) - 36),
          }}
        >
          <span className="text-zinc-500 dark:text-zinc-400">step </span>
          <span className="text-zinc-900 dark:text-zinc-100">{hover.step}</span>
          {hover.loss !== null ? (
            <>
              <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-zinc-500 dark:text-zinc-400">loss </span>
              <span className="text-teal-600 dark:text-teal-300">
                {hover.loss.toFixed(4)}
              </span>
            </>
          ) : null}
          {hover.evalLoss !== null ? (
            <>
              <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-zinc-500 dark:text-zinc-400">eval </span>
              <span className="text-pink-600 dark:text-pink-300">
                {hover.evalLoss.toFixed(4)}
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {advanced ? (
        <AdvancedStats train={trainStats} evalStats={evalStats} />
      ) : null}
    </div>
  );
}

function Legend({
  hasTrain,
  hasEval,
}: {
  hasTrain: boolean;
  hasEval: boolean;
}) {
  if (!hasTrain && !hasEval) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-zinc-600 dark:text-zinc-400">
      {hasTrain ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4 rounded-full"
            style={{ backgroundColor: TRAIN_STROKE }}
          />
          Training loss
        </span>
      ) : null}
      {hasEval ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4 rounded-full"
            style={{
              backgroundImage: `linear-gradient(to right, ${EVAL_STROKE} 60%, transparent 60%)`,
              backgroundSize: "6px 100%",
            }}
          />
          Eval loss
        </span>
      ) : null}
    </div>
  );
}

function AdvancedStats({
  train,
  evalStats,
}: {
  train: LossStats | null;
  evalStats: LossStats | null;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <StatsCard label="Training loss" tone="train" stats={train} />
      <StatsCard
        label="Eval loss"
        tone="eval"
        stats={evalStats}
        emptyHint="Awaiting training.log events with evalLoss…"
      />
    </div>
  );
}

function StatsCard({
  label,
  tone,
  stats,
  emptyHint,
}: {
  label: string;
  tone: "train" | "eval";
  stats: LossStats | null;
  emptyHint?: string;
}) {
  const accent =
    tone === "train"
      ? "text-teal-600 dark:text-teal-300"
      : "text-pink-600 dark:text-pink-300";
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-2 flex items-center justify-between">
        <span className={`text-[11px] font-medium uppercase tracking-wide ${accent}`}>
          {label}
        </span>
        <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
          n = {stats?.count ?? 0}
        </span>
      </div>
      {stats === null ? (
        <div className="py-2 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
          {emptyHint ?? "No data yet."}
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
          <Row term="Mean CE" value={`${stats.mean.toFixed(4)} ± ${stats.ci95.toFixed(4)}`} hint="95% CI" />
          <Row term="Std dev" value={stats.stddev.toFixed(4)} />
          <Row term="Variance" value={stats.variance.toFixed(4)} />
          <Row term="p90" value={stats.p90.toFixed(4)} />
          <Row term="p95" value={stats.p95.toFixed(4)} />
        </dl>
      )}
    </div>
  );
}

function Row({ term, value, hint }: { term: string; value: string; hint?: string }) {
  return (
    <>
      <dt className="text-zinc-500 dark:text-zinc-400">
        {term}
        {hint ? (
          <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-500">
            ({hint})
          </span>
        ) : null}
      </dt>
      <dd className="text-right text-zinc-900 dark:text-zinc-100">{value}</dd>
    </>
  );
}
