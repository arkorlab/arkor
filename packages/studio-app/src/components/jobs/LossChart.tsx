import { useEffect, useRef, useState } from "react";

export interface LossPoint {
  step: number;
  loss: number | null;
}

const HEIGHT = 240;
const PADDING = { top: 16, right: 16, bottom: 28, left: 48 };

export function LossChart({ points }: { points: LossPoint[] }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<LossPoint | null>(null);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const el = wrapperRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setWidth(Math.max(320, Math.floor(e.contentRect.width)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const numeric = points.filter(
    (p): p is { step: number; loss: number } => typeof p.loss === "number",
  );

  if (numeric.length === 0) {
    return (
      <div
        ref={wrapperRef}
        className="flex h-60 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
      >
        Waiting for training.log events…
      </div>
    );
  }

  const minLoss = Math.min(...numeric.map((p) => p.loss));
  const maxLoss = Math.max(...numeric.map((p) => p.loss));
  const span = Math.max(0.0001, maxLoss - minLoss);
  const lastStep = Math.max(1, numeric[numeric.length - 1]!.step);
  const innerW = Math.max(50, width - PADDING.left - PADDING.right);
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;

  function xFor(step: number) {
    return PADDING.left + (step / lastStep) * innerW;
  }
  function yFor(loss: number) {
    return PADDING.top + (1 - (loss - minLoss) / span) * innerH;
  }

  const linePath = numeric
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.step).toFixed(2)},${yFor(p.loss).toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L${xFor(numeric[numeric.length - 1]!.step).toFixed(2)},${PADDING.top + innerH} L${xFor(numeric[0]!.step).toFixed(2)},${PADDING.top + innerH} Z`;

  const gridSteps = 4;
  const yTicks = Array.from({ length: gridSteps + 1 }).map((_, i) => {
    const t = i / gridSteps;
    const value = maxLoss - t * span;
    return { y: PADDING.top + t * innerH, value };
  });
  const xTickCount = Math.min(6, numeric.length);
  const xTicks = Array.from({ length: xTickCount }).map((_, i) => {
    const t = xTickCount === 1 ? 0 : i / (xTickCount - 1);
    return Math.round(t * lastStep);
  });

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = (x - PADDING.left) / innerW;
    const targetStep = Math.round(fraction * lastStep);
    // training.log events arrive in step order, so `numeric` is sorted
    // by `.step` — binary search for the insertion point and then pick
    // whichever neighbour is closer (O(log n) vs the previous O(n)
    // sweep that was running on every mousemove against up to
    // MAX_LOSS_POINTS=2000 entries).
    let lo = 0;
    let hi = numeric.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (numeric[mid]!.step < targetStep) lo = mid + 1;
      else hi = mid;
    }
    const candidate = numeric[lo]!;
    const before = lo > 0 ? numeric[lo - 1]! : candidate;
    const nearest =
      Math.abs(before.step - targetStep) <= Math.abs(candidate.step - targetStep)
        ? before
        : candidate;
    setHover(nearest);
  }

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

        <path d={areaPath} fill="url(#loss-area)" />
        <path
          d={linePath}
          fill="none"
          stroke="rgb(20 184 166)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

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
            <circle
              cx={xFor(hover.step)}
              cy={yFor(hover.loss as number)}
              r={3.5}
              fill="white"
              stroke="rgb(20 184 166)"
              strokeWidth={2}
            />
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

      {hover ? (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-mono shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
          style={{
            left: xFor(hover.step),
            top: Math.max(0, yFor(hover.loss as number) - 36),
          }}
        >
          <span className="text-zinc-500 dark:text-zinc-400">step </span>
          <span className="text-zinc-900 dark:text-zinc-100">{hover.step}</span>
          <span className="mx-1.5 text-zinc-300 dark:text-zinc-700">·</span>
          <span className="text-zinc-500 dark:text-zinc-400">loss </span>
          <span className="text-teal-600 dark:text-teal-300">
            {(hover.loss as number).toFixed(4)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
