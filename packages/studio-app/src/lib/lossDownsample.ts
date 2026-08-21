import type { LossPoint } from "../components/jobs/LossChart";

/**
 * Compacts `points` down to at most `targetSize` representatives while
 * preserving, in strict priority order (each tier only yields budget to
 * the next once it's satisfied):
 *  1. the first and last point (run boundaries)
 *  2. every point carrying a finite `evalLoss` (that series is sparse
 *     relative to `loss`, so keeping all of it is normally cheap; it is
 *     only sampled down if it alone would exceed the remaining budget,
 *     which should be rare given how sparse it typically is)
 *  3. local minima/maxima of the `loss` series (so visible spikes
 *     survive compaction), sampled down if they don't fit
 *  4. remaining budget filled with evenly-spaced points from what's
 *     left, so the overall shape of the run stays visible at coarser
 *     resolution
 *
 * The strict tiering matters: without it, a run with frequent extrema
 * (spiky loss) could crowd out the sparse `evalLoss` series in an
 * even-sample over the combined must-keep set, breaking the promise
 * that `evalLoss` survives compaction.
 *
 * Output is always a subsequence of the input in original order, so
 * callers relying on the array staying sorted by `step` (e.g.
 * `LossChart`'s binary-search tooltip) are unaffected.
 *
 * Known limitation: when the extrema set itself exceeds the remaining
 * budget (tier 3), the excess is stride-sampled by position, the same
 * as the generic filler tier, rather than bucketed to preserve the
 * frequency of oscillation. For a genuinely high-frequency oscillating
 * series (rapid alternation, not just noisy-but-trending loss), this
 * can produce runs of same-parity samples that visually read as a
 * smoother or more settled curve than the underlying data actually
 * was. A bucketed min/max scheme for this tier specifically would be
 * a further improvement; not attempted here since it's a distinct,
 * more involved change from fixing the tail-truncation and
 * evalLoss-priority issues this module addresses.
 */
export function compactLossPoints(
  points: LossPoint[],
  targetSize: number,
): LossPoint[] {
  if (targetSize < 1) return [];
  if (points.length <= targetSize) return points;
  if (targetSize === 1) {
    const last = points.at(-1);
    return last ? [last] : [];
  }

  const boundaryIndices = new Set<number>([0, points.length - 1]);

  const evalLossIndices: number[] = [];
  for (const [i, point] of points.entries()) {
    if (boundaryIndices.has(i)) continue;
    const e = point.evalLoss;
    if (typeof e === "number" && Number.isFinite(e)) evalLossIndices.push(i);
  }

  // Local minima/maxima of the `loss` series, compared across the
  // filtered subsequence of non-null loss values so a run of null-loss
  // frames between two real values doesn't block extrema detection.
  const lossIndices: number[] = [];
  for (const [i, point] of points.entries()) {
    if (point.loss !== null) lossIndices.push(i);
  }
  const extremaIndices: number[] = [];
  for (let k = 1; k < lossIndices.length - 1; k++) {
    const idx = lossIndices[k];
    if (boundaryIndices.has(idx)) continue;
    const prev = points[lossIndices[k - 1]].loss;
    const cur = points[idx].loss;
    const next = points[lossIndices[k + 1]].loss;
    // `lossIndices` only holds indices where `loss !== null`, so this
    // is unreachable; the guard just keeps the comparison below
    // type-safe without a non-null assertion.
    if (prev === null || cur === null || next === null) continue;
    // Requiring strictness on at least one side (rather than allowing
    // `cur <= prev && cur <= next` alone) keeps flat/constant loss
    // runs from flagging almost every point as a "tied" extremum,
    // which would otherwise flood this tier and crowd out `evalLoss`
    // and generic filler once the combined set exceeds `targetSize`.
    const isMax = cur >= prev && cur >= next && (cur > prev || cur > next);
    const isMin = cur <= prev && cur <= next && (cur < prev || cur < next);
    if (isMax || isMin) extremaIndices.push(idx);
  }

  const selected = new Set<number>(boundaryIndices);

  // Tier 2: evalLoss. Sampled down only if it alone exceeds what's
  // left after boundaries, so it is never crowded out by extrema.
  let budget = targetSize - selected.size;
  if (budget > 0 && evalLossIndices.length > 0) {
    const kept = evenSample(
      evalLossIndices,
      Math.min(budget, evalLossIndices.length),
    );
    for (const i of kept) selected.add(i);
  }

  // Tier 3: extrema, sampled down if they don't fit in what's left.
  budget = targetSize - selected.size;
  if (budget > 0 && extremaIndices.length > 0) {
    const kept = evenSample(
      extremaIndices,
      Math.min(budget, extremaIndices.length),
    );
    for (const i of kept) selected.add(i);
  }

  // Tier 4: generic filler from everything not already selected.
  budget = targetSize - selected.size;
  if (budget > 0) {
    const notKept: number[] = [];
    for (const [i] of points.entries()) {
      if (!selected.has(i)) notKept.push(i);
    }
    const filler = evenSample(notKept, Math.min(budget, notKept.length));
    for (const i of filler) selected.add(i);
  }

  // `[...selected].sort(...)` (not `.toSorted()`) because the Studio
  // SPA's tsconfig pins `target: ES2022` and `Array.prototype.toSorted`
  // is ES2023; Vite/esbuild won't polyfill it, so older evergreen
  // browsers would throw. See `stats.ts` / `LossChart.tsx` for the same
  // rationale.
  // eslint-disable-next-line unicorn/no-array-sort
  const finalSorted = [...selected].sort((a, b) => a - b);
  return finalSorted.map((i) => points[i]);
}

/**
 * Picks `count` evenly-spaced entries from `indices` (already sorted
 * ascending), always keeping the first and last entry. Callers only
 * invoke this when `indices.length >= count`.
 */
function evenSample(indices: number[], count: number): number[] {
  if (count <= 0) return [];
  if (count >= indices.length) return indices;
  if (count === 1) {
    const last = indices.at(-1);
    return last === undefined ? [] : [last];
  }

  const lastIdx = indices.length - 1;
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const pos = Math.round((i * lastIdx) / (count - 1));
    result.push(indices[pos]);
  }
  // Rounding can collide on nearby positions when `count` is close to
  // `indices.length`; dedupe while preserving ascending order.
  return [...new Set(result)];
}
