import type { LossPoint } from "../components/jobs/LossChart";

/**
 * Compacts `points` down to at most `targetSize` representatives while
 * preserving:
 *  - the first and last point (run boundaries)
 *  - every point carrying a finite `evalLoss` (that series is sparse
 *    relative to `loss`, so keeping all of it is cheap)
 *  - local minima/maxima of the `loss` series (so visible spikes
 *    survive compaction)
 * Remaining budget is filled with evenly-spaced points from what's
 * left, so the overall shape of the run stays visible at coarser
 * resolution.
 *
 * Output is always a subsequence of the input in original order, so
 * callers relying on the array staying sorted by `step` (e.g.
 * `LossChart`'s binary-search tooltip) are unaffected.
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

  const mustKeep = new Set<number>([0, points.length - 1]);

  for (const [i, point] of points.entries()) {
    const e = point.evalLoss;
    if (typeof e === "number" && Number.isFinite(e)) mustKeep.add(i);
  }

  // Local minima/maxima of the `loss` series, compared across the
  // filtered subsequence of non-null loss values so a run of null-loss
  // frames between two real values doesn't block extrema detection.
  const lossIndices: number[] = [];
  for (const [i, point] of points.entries()) {
    if (point.loss !== null) lossIndices.push(i);
  }
  for (let k = 1; k < lossIndices.length - 1; k++) {
    const prev = points[lossIndices[k - 1]].loss;
    const cur = points[lossIndices[k]].loss;
    const next = points[lossIndices[k + 1]].loss;
    // `lossIndices` only holds indices where `loss !== null`, so this
    // is unreachable; the guard just keeps the comparison below
    // type-safe without a non-null assertion.
    if (prev === null || cur === null || next === null) continue;
    // Requiring strictness on at least one side (rather than allowing
    // `cur <= prev && cur <= next` alone) keeps flat/constant loss
    // runs from flagging almost every point as a "tied" extremum,
    // which would otherwise flood `mustKeep` and crowd out genuine
    // spikes once the must-keep set exceeds `targetSize` and falls
    // back to even-sampling.
    const isMax = cur >= prev && cur >= next && (cur > prev || cur > next);
    const isMin = cur <= prev && cur <= next && (cur < prev || cur < next);
    if (isMax || isMin) {
      mustKeep.add(lossIndices[k]);
    }
  }

  const mustKeepSorted = [...mustKeep].toSorted((a, b) => a - b);

  let selected: number[];
  if (mustKeepSorted.length >= targetSize) {
    // Too many "must keep" points to fit the budget: evenly sample
    // down from the must-keep set itself. `evenSample` always retains
    // its own first/last entry, so run boundaries survive either way.
    selected = evenSample(mustKeepSorted, targetSize);
  } else {
    const remainingBudget = targetSize - mustKeepSorted.length;
    const notKept: number[] = [];
    for (const [i] of points.entries()) {
      if (!mustKeep.has(i)) notKept.push(i);
    }
    const filler = evenSample(notKept, remainingBudget);
    selected = [...mustKeepSorted, ...filler].toSorted((a, b) => a - b);
  }

  return selected.map((i) => points[i]);
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
