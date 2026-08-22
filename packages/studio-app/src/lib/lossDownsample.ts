import type { LossPoint } from "../components/jobs/LossChart";

/**
 * Compacts `points` down to at most `targetSize` representatives.
 *
 * Passes, each protecting a category from being crowded out by
 * another that competes for the same step-value buckets:
 *
 * 1. Merge duplicate `step`s first (a later frame's non-null fields
 *    win, matching `LossChart`'s own by-step merge exactly). Without
 *    this, a step whose training-loss and eval-loss arrive as two
 *    separate frames (an explicitly supported shape: see
 *    `LossChart.tsx`'s "eval-only frames" comment) could have
 *    compaction keep one frame and drop the other, silently losing
 *    that step's value even though `LossChart` would otherwise have
 *    merged them.
 * 2. Split the remaining budget (after 2 slots reserved for the hard
 *    first/last boundaries) between the `evalLoss` series and the
 *    `loss` series, each getting up to half, with any unused share
 *    from a sparser series water-filled to the other. Without this,
 *    a dense `evalLoss` series (frequent eval-only frames) can win
 *    almost every step-value bucket outright and crowd the
 *    training-loss series out of the chart almost entirely.
 * 3. Within the loss series' own budget, further split between local
 *    maxima and local minima (again up to half each, water-filled),
 *    before falling through to ordinary (non-extremum) points for
 *    whatever's left. Without this, a genuinely oscillating series
 *    (rapid alternation between a min and a max) can have one side
 *    of the oscillation win every bucket it competes in purely by
 *    array order, aliasing the retained shape into a false broad
 *    trend instead of showing the real back-and-forth.
 * 4. Within each of these budgets, bucket that category's candidate
 *    points into equal-width buckets by *step value* (not array
 *    position), keeping one representative per bucket.
 *
 * Bucketing by step value (rather than sampling evenly by array
 * position, which an earlier version of this function did) matters
 * for repeated compaction: `JobDetail` calls this every time the
 * retained array re-fills past the cap, on an already-compacted
 * array. Position-based sampling gives newly-appended raw points and
 * older, already-thinned survivors equal weight *by count*, which
 * geometrically erodes how many representatives the original early
 * history keeps after enough compaction passes (verified: a 50k-step
 * simulation left only the first two steps below step 1,000, jumping
 * straight to roughly step 39,000). Bucketing by step value instead
 * ties each pass's coverage to the actual step range, which stays
 * stable across repeated passes regardless of how many raw points
 * currently occupy any given region.
 *
 * Output is always a subsequence of the merged points in step order,
 * so callers relying on the array staying sorted by `step` (e.g.
 * `LossChart`'s binary-search tooltip) are unaffected.
 */
export function compactLossPoints(
  points: LossPoint[],
  targetSize: number,
): LossPoint[] {
  if (targetSize < 1) return [];

  const merged = mergeByStep(points);

  if (merged.length <= targetSize) return merged;
  if (targetSize === 1) {
    const last = merged.at(-1);
    return last ? [last] : [];
  }
  if (targetSize === 2) {
    const last = merged.at(-1);
    return last ? [merged[0], last] : [merged[0]];
  }

  const firstStep = merged[0].step;
  const lastStepPoint = merged.at(-1);
  const lastStep = lastStepPoint ? lastStepPoint.step : firstStep;
  const span = lastStep - firstStep;
  const bucketCount = targetSize - 2;

  const evalCandidates: number[] = [];
  const lossCandidates: number[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const p = merged[i];
    if (typeof p.evalLoss === "number" && Number.isFinite(p.evalLoss)) {
      evalCandidates.push(i);
    }
    if (p.loss !== null) lossCandidates.push(i);
  }

  // Local minima/maxima of the `loss` series, compared across the
  // filtered subsequence of non-null loss values so a run of null-loss
  // frames between two real values doesn't block extrema detection.
  // 0 = neither, 1 = local min, 2 = local max.
  //
  // Detection uses the FULL loss-bearing index range (including the
  // boundaries), not just `lossCandidates` (which excludes them as
  // selection targets, since boundaries are already force-included
  // separately): without the boundary values as neighbor context, a
  // spike sitting immediately after/before a boundary could never be
  // correctly compared against its true neighbor and would silently
  // fail to be flagged as an extremum at all.
  const lossIndicesFull: number[] = [];
  for (const [i, point] of merged.entries()) {
    if (point.loss !== null) lossIndicesFull.push(i);
  }
  const extremumKind: number[] = Array.from({ length: merged.length }, () => 0);
  for (let k = 1; k < lossIndicesFull.length - 1; k++) {
    const idx = lossIndicesFull[k];
    const prev = merged[lossIndicesFull[k - 1]].loss;
    const cur = merged[idx].loss;
    const next = merged[lossIndicesFull[k + 1]].loss;
    // `lossIndicesFull` only holds indices where `loss !== null`, so
    // this is unreachable; the guard just keeps the comparison below
    // type-safe without a non-null assertion.
    if (prev === null || cur === null || next === null) continue;
    // Requiring strictness on at least one side (rather than allowing
    // `cur <= prev && cur <= next` alone) keeps flat/constant loss
    // runs from flagging almost every point as a "tied" extremum.
    const isMax = cur >= prev && cur >= next && (cur > prev || cur > next);
    const isMin = cur <= prev && cur <= next && (cur < prev || cur < next);
    if (isMax) extremumKind[idx] = 2;
    else if (isMin) extremumKind[idx] = 1;
  }

  // Split the shared budget between the two series, each getting up
  // to half; a sparser series (commonly `evalLoss`) leaves its unused
  // share to the other rather than forcing an even split regardless
  // of actual candidate counts.
  const half = Math.ceil(bucketCount / 2);
  const evalBudget = Math.min(half, evalCandidates.length);
  const evalSelected = bucketSelect(
    merged,
    evalCandidates,
    evalBudget,
    firstStep,
    span,
  );
  const evalSelectedSet = new Set(evalSelected);

  // Exclude anything already claimed by the eval tier so its budget
  // isn't wasted re-selecting a point the output already contains.
  const lossCandidatesRemaining = lossCandidates.filter(
    (i) => !evalSelectedSet.has(i),
  );
  const lossBudget = Math.min(
    bucketCount - evalSelected.length,
    lossCandidatesRemaining.length,
  );

  // Within the loss budget, protect both sides of an oscillating
  // series from each other the same way eval and loss protect each
  // other above: local maxima and local minima each get up to half,
  // water-filled, before ordinary (non-extremum) points get whatever
  // remains.
  const maxCandidates = lossCandidatesRemaining.filter(
    (i) => extremumKind[i] === 2,
  );
  const minCandidates = lossCandidatesRemaining.filter(
    (i) => extremumKind[i] === 1,
  );
  const plainCandidates = lossCandidatesRemaining.filter(
    (i) => extremumKind[i] === 0,
  );

  const extremaHalf = Math.ceil(lossBudget / 2);
  const maxBudget = Math.min(extremaHalf, maxCandidates.length);
  const maxSelected = bucketSelect(
    merged,
    maxCandidates,
    maxBudget,
    firstStep,
    span,
  );
  const minBudget = Math.min(
    lossBudget - maxSelected.length,
    minCandidates.length,
  );
  const minSelected = bucketSelect(
    merged,
    minCandidates,
    minBudget,
    firstStep,
    span,
  );
  const plainBudget = Math.min(
    lossBudget - maxSelected.length - minSelected.length,
    plainCandidates.length,
  );
  const plainSelected = bucketSelect(
    merged,
    plainCandidates,
    plainBudget,
    firstStep,
    span,
  );

  const selected = new Set<number>([0, merged.length - 1]);
  for (const i of evalSelected) selected.add(i);
  for (const i of maxSelected) selected.add(i);
  for (const i of minSelected) selected.add(i);
  for (const i of plainSelected) selected.add(i);

  // `[...selected].sort(...)` (not `.toSorted()`) because the Studio
  // SPA's tsconfig pins `target: ES2022` and `Array.prototype.toSorted`
  // is ES2023; Vite/esbuild won't polyfill it, so older evergreen
  // browsers would throw. See `stats.ts` / `LossChart.tsx` for the same
  // rationale.
  // eslint-disable-next-line unicorn/no-array-sort
  const finalSorted = [...selected].sort((a, b) => a - b);
  return finalSorted.map((i) => merged[i]);
}

/**
 * Buckets `candidates` (indices into `points`) into `budget`
 * equal-width buckets spanning `[firstStep, firstStep + span]` by
 * step value, keeping one representative per bucket (the first
 * candidate seen for that bucket). Returns at most `budget` indices.
 */
function bucketSelect(
  points: LossPoint[],
  candidates: number[],
  budget: number,
  firstStep: number,
  span: number,
): number[] {
  if (budget <= 0 || candidates.length === 0) return [];
  if (candidates.length <= budget) return candidates;

  const winner: (number | null)[] = Array.from({ length: budget }, () => null);

  for (const idx of candidates) {
    const step = points[idx].step;
    let b = span === 0 ? 0 : Math.floor(((step - firstStep) / span) * budget);
    if (b >= budget) b = budget - 1;
    if (b < 0) b = 0;
    winner[b] ??= idx;
  }

  const result: number[] = [];
  for (const idx of winner) if (idx !== null) result.push(idx);
  return result;
}

/**
 * Merges points sharing the same `step` into one entry, with a later
 * frame's non-null `loss` / non-null `evalLoss` overwriting an
 * earlier frame's for that step. Matches `LossChart`'s own by-step
 * merge semantics (see its `unified` builder) so compaction never
 * splits a step's training-loss and eval-loss across two entries that
 * could independently survive or be dropped.
 *
 * Assumes `points` arrives in non-decreasing step order (true for the
 * SSE append order `JobDetail` builds this array in); output preserves
 * first-occurrence order per step.
 */
function mergeByStep(points: LossPoint[]): LossPoint[] {
  const byStep = new Map<number, LossPoint>();
  for (const p of points) {
    const existing = byStep.get(p.step);
    if (!existing) {
      byStep.set(p.step, { ...p });
      continue;
    }
    if (p.loss !== null) existing.loss = p.loss;
    if (typeof p.evalLoss === "number" && Number.isFinite(p.evalLoss)) {
      existing.evalLoss = p.evalLoss;
    }
  }
  return [...byStep.values()];
}
