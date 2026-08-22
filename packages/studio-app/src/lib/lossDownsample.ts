import type { LossPoint } from "../components/jobs/LossChart";

/**
 * Compacts `points` down to at most `targetSize` representatives.
 *
 * Three passes:
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
 *    from a sparser series water-filled to the other. Without this
 *    split, a dense `evalLoss` series (frequent eval-only frames) can
 *    win almost every step-value bucket outright and crowd the
 *    training-loss series out of the chart almost entirely.
 * 3. Within each series' own budget, bucket that series' candidate
 *    points into equal-width buckets by *step value* (not array
 *    position), keeping one representative per bucket: for the loss
 *    series, a local extremum is preferred within its bucket over an
 *    ordinary point, so visible spikes survive.
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
  const isExtremum: boolean[] = Array.from(
    { length: merged.length },
    () => false,
  );
  for (let k = 1; k < lossCandidates.length - 1; k++) {
    const idx = lossCandidates[k];
    const prev = merged[lossCandidates[k - 1]].loss;
    const cur = merged[idx].loss;
    const next = merged[lossCandidates[k + 1]].loss;
    // `lossCandidates` only holds indices where `loss !== null`, so
    // this is unreachable; the guard just keeps the comparison below
    // type-safe without a non-null assertion.
    if (prev === null || cur === null || next === null) continue;
    // Requiring strictness on at least one side (rather than allowing
    // `cur <= prev && cur <= next` alone) keeps flat/constant loss
    // runs from flagging almost every point as a "tied" extremum.
    const isMax = cur >= prev && cur >= next && (cur > prev || cur > next);
    const isMin = cur <= prev && cur <= next && (cur < prev || cur < next);
    if (isMax || isMin) isExtremum[idx] = true;
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
    () => 0,
  );
  const lossBudget = Math.min(
    bucketCount - evalSelected.length,
    lossCandidates.length,
  );
  const lossSelected = bucketSelect(
    merged,
    lossCandidates,
    lossBudget,
    firstStep,
    span,
    (i) => (isExtremum[i] ? 1 : 0),
  );

  const selected = new Set<number>([0, merged.length - 1]);
  for (const i of evalSelected) selected.add(i);
  for (const i of lossSelected) selected.add(i);

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
 * step value, keeping the highest-`priorityOf`-ranked candidate per
 * bucket (ties keep whichever candidate was seen first). Returns at
 * most `budget` indices.
 */
function bucketSelect(
  points: LossPoint[],
  candidates: number[],
  budget: number,
  firstStep: number,
  span: number,
  priorityOf: (index: number) => number,
): number[] {
  if (budget <= 0 || candidates.length === 0) return [];
  if (candidates.length <= budget) return candidates;

  const winner: (number | null)[] = Array.from({ length: budget }, () => null);
  const winnerRank: number[] = Array.from({ length: budget }, () => -1);

  for (const idx of candidates) {
    const step = points[idx].step;
    let b = span === 0 ? 0 : Math.floor(((step - firstStep) / span) * budget);
    if (b >= budget) b = budget - 1;
    if (b < 0) b = 0;
    const rank = priorityOf(idx);
    if (rank > winnerRank[b]) {
      winner[b] = idx;
      winnerRank[b] = rank;
    }
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
