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
 *    merged them. The merged result is sorted by step defensively
 *    (`Map` preserves insertion order, not step order; an
 *    out-of-order frame, e.g. from an SSE reconnect replay, would
 *    otherwise corrupt the first/last boundary and bucket-width
 *    calculations below).
 * 2. Split the remaining budget after reserving the first and last
 *    finite point of each plotted series (when the target can hold
 *    them) between the `evalLoss` series and the `loss` series. Each
 *    gets up to half; if one series has fewer candidates than its
 *    half, the unused share flows to the other. A second reclaim pass
 *    fills any *still* stranded capacity from every remaining
 *    candidate in either series. It prefers eval extrema, then other
 *    eval points, then loss extrema, then ordinary loss points.
 *    Bucket collisions and series overlap (a point with both `loss`
 *    and `evalLoss`) can otherwise leave slots unused even though
 *    candidates remain.
 * 3. Within the loss series' own budget, the same bidirectional split
 *    applies one level down: local maxima and local minima each get
 *    up to half, with either side's unused share flowing to the
 *    other, before ordinary (non-extremum) points get whatever
 *    remains. Without this, a genuinely oscillating series can have
 *    one side of the oscillation win every bucket it competes in
 *    purely by array order, aliasing the retained shape into a false
 *    broad trend instead of showing the real back-and-forth.
 * 4. Within each of these budgets, bucket that category's candidate
 *    points into equal-width buckets by *step value* (not array
 *    position), keeping the most significant representative per
 *    bucket: for loss maxima, the highest loss value in that bucket;
 *    for loss minima and eval minima, the lowest; for loss maxima and
 *    eval maxima, the highest; for plain filler, first-seen. Picking
 *    merely the first-seen candidate regardless of magnitude could
 *    let a modest point win a bucket over a genuinely severe spike
 *    that happens to sit later in the same bucket, silently erasing
 *    exactly the kind of point this preservation exists for.
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
  if (!Number.isFinite(targetSize)) return [];
  const normalizedTargetSize = Math.floor(targetSize);
  if (normalizedTargetSize < 1) return [];

  const merged = mergeByStep(points);

  if (merged.length <= normalizedTargetSize) return merged;
  if (normalizedTargetSize === 1) {
    const last = merged.at(-1);
    return last ? [last] : [];
  }
  if (normalizedTargetSize === 2) {
    const last = merged.at(-1);
    return last ? [merged[0], last] : [merged[0]];
  }

  const firstStep = merged[0].step;
  const lastStepPoint = merged.at(-1);
  const lastStep = lastStepPoint ? lastStepPoint.step : firstStep;
  const span = lastStep - firstStep;

  const lossIndicesFull: number[] = [];
  const evalIndicesFull: number[] = [];
  for (const [i, point] of merged.entries()) {
    if (point.loss !== null) lossIndicesFull.push(i);
    if (typeof point.evalLoss === "number" && Number.isFinite(point.evalLoss)) {
      evalIndicesFull.push(i);
    }
  }

  const mandatoryBoundaryIndices = new Set<number>([0, merged.length - 1]);
  if (lossIndicesFull.length > 0) {
    const lastLossIndex = lossIndicesFull.at(-1);
    mandatoryBoundaryIndices.add(lossIndicesFull[0]);
    if (lastLossIndex !== undefined)
      mandatoryBoundaryIndices.add(lastLossIndex);
  }
  if (evalIndicesFull.length > 0) {
    const lastEvalIndex = evalIndicesFull.at(-1);
    mandatoryBoundaryIndices.add(evalIndicesFull[0]);
    if (lastEvalIndex !== undefined)
      mandatoryBoundaryIndices.add(lastEvalIndex);
  }
  const boundaryIndices =
    mandatoryBoundaryIndices.size <= normalizedTargetSize
      ? mandatoryBoundaryIndices
      : new Set<number>([0, merged.length - 1]);
  const bucketCount = normalizedTargetSize - boundaryIndices.size;

  const evalCandidates: number[] = [];
  const lossCandidates: number[] = [];
  for (const [i, p] of merged.entries()) {
    if (boundaryIndices.has(i)) continue;
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
  const extremumKind: number[] = Array.from({ length: merged.length }, () => 0);
  for (const [offset, idx] of lossIndicesFull.slice(1, -1).entries()) {
    const k = offset + 1;
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

  // Local extrema of the `evalLoss` series, same algorithm as above.
  // Maxima and minima get separate sub-budgets so opposite extrema in
  // the same step bucket cannot erase one another; ordinary eval
  // values use whatever remains.
  const evalExtremumKind: number[] = Array.from(
    { length: merged.length },
    () => 0,
  );
  for (const [offset, idx] of evalIndicesFull.slice(1, -1).entries()) {
    const k = offset + 1;
    const prev = merged[evalIndicesFull[k - 1]].evalLoss;
    const cur = merged[idx].evalLoss;
    const next = merged[evalIndicesFull[k + 1]].evalLoss;
    if (
      typeof prev !== "number" ||
      typeof cur !== "number" ||
      typeof next !== "number"
    ) {
      continue;
    }
    const isMax = cur >= prev && cur >= next && (cur > prev || cur > next);
    const isMin = cur <= prev && cur <= next && (cur < prev || cur < next);
    if (isMax) evalExtremumKind[idx] = 2;
    else if (isMin) evalExtremumKind[idx] = 1;
  }

  // Split the shared budget between the two series, each getting up
  // to half, with either side's unused share flowing to the other
  // (based on raw candidate counts; the loss side's *actual* budget
  // below is then adjusted for the overlap exclusion just after).
  const [evalBudget] = splitBudget(
    bucketCount,
    evalCandidates.length,
    lossCandidates.length,
  );
  const evalMaxCandidates = evalCandidates.filter(
    (i) => evalExtremumKind[i] === 2,
  );
  const evalMinCandidates = evalCandidates.filter(
    (i) => evalExtremumKind[i] === 1,
  );
  const evalPlainCandidates = evalCandidates.filter(
    (i) => evalExtremumKind[i] === 0,
  );
  const [evalMaxBudget, evalMinBudget] = splitBudget(
    evalBudget,
    evalMaxCandidates.length,
    evalMinCandidates.length,
  );
  const evalMaxSelected = bucketSelect(
    merged,
    evalMaxCandidates,
    evalMaxBudget,
    firstStep,
    span,
    (a, b) =>
      (merged[a].evalLoss ?? -Infinity) > (merged[b].evalLoss ?? -Infinity),
  );
  const evalMinSelected = bucketSelect(
    merged,
    evalMinCandidates,
    evalMinBudget,
    firstStep,
    span,
    (a, b) =>
      (merged[a].evalLoss ?? Infinity) < (merged[b].evalLoss ?? Infinity),
  );
  const evalPlainBudget = Math.min(
    evalBudget - evalMaxSelected.length - evalMinSelected.length,
    evalPlainCandidates.length,
  );
  const evalPlainSelected = bucketSelect(
    merged,
    evalPlainCandidates,
    evalPlainBudget,
    firstStep,
    span,
  );
  const evalSelected = [
    ...evalMaxSelected,
    ...evalMinSelected,
    ...evalPlainSelected,
  ];
  const evalSelectedSet = new Set(evalSelected);

  // Exclude anything already claimed by the eval tier so its budget
  // isn't wasted re-selecting a point the output already contains.
  // Loss's actual budget is whatever's left after eval's *real*
  // selection (which can be slightly less than `evalBudget` if bucket
  // collisions reduced it), so the total budget stays fully used.
  const lossCandidatesRemaining = lossCandidates.filter(
    (i) => !evalSelectedSet.has(i),
  );
  const lossBudget = Math.min(
    bucketCount - evalSelected.length,
    lossCandidatesRemaining.length,
  );

  const maxCandidates = lossCandidatesRemaining.filter(
    (i) => extremumKind[i] === 2,
  );
  const minCandidates = lossCandidatesRemaining.filter(
    (i) => extremumKind[i] === 1,
  );
  const plainCandidates = lossCandidatesRemaining.filter(
    (i) => extremumKind[i] === 0,
  );

  const [maxBudget, minBudget] = splitBudget(
    lossBudget,
    maxCandidates.length,
    minCandidates.length,
  );
  const maxSelected = bucketSelect(
    merged,
    maxCandidates,
    maxBudget,
    firstStep,
    span,
    (a, b) => (merged[a].loss ?? -Infinity) > (merged[b].loss ?? -Infinity),
  );
  const minSelected = bucketSelect(
    merged,
    minCandidates,
    minBudget,
    firstStep,
    span,
    (a, b) => (merged[a].loss ?? Infinity) < (merged[b].loss ?? Infinity),
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

  const selected = new Set<number>(boundaryIndices);
  for (const i of evalSelected) selected.add(i);
  for (const i of maxSelected) selected.add(i);
  for (const i of minSelected) selected.add(i);
  for (const i of plainSelected) selected.add(i);

  // Bucket collisions and overlap between the eval and loss series can
  // leave capacity unused even though either series still has candidates.
  // Reclaim that slack from every remaining candidate, while preferring
  // eval extrema, then other eval points, then loss extrema.
  const strandedLeftover = bucketCount - (selected.size - boundaryIndices.size);
  if (strandedLeftover > 0) {
    const evalCandidateSet = new Set(evalCandidates);
    const lossExtremumSet = new Set([...maxCandidates, ...minCandidates]);
    const unclaimed = [
      ...new Set([
        ...evalCandidates,
        ...maxCandidates,
        ...minCandidates,
        ...plainCandidates,
      ]),
    ].filter((i) => !selected.has(i));
    if (unclaimed.length > 0) {
      const reclaimed = bucketSelect(
        merged,
        unclaimed,
        Math.min(strandedLeftover, unclaimed.length),
        firstStep,
        span,
        (a, b) => {
          const rank = (i: number) =>
            evalExtremumKind[i] !== 0
              ? 3
              : evalCandidateSet.has(i)
                ? 2
                : lossExtremumSet.has(i)
                  ? 1
                  : 0;
          return rank(a) > rank(b);
        },
      );
      for (const i of reclaimed) selected.add(i);

      // Multiple unclaimed candidates can share a bucket, so the
      // representative pass may return fewer points than its budget.
      // Fill any remaining slots directly to keep the output at the
      // requested size when enough candidates remain.
      for (const i of unclaimed) {
        if (selected.size - boundaryIndices.size >= bucketCount) break;
        if (!selected.has(i)) selected.add(i);
      }
    }
  }

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
 * Splits `total` between two candidate pools of size `countA` /
 * `countB`, each getting up to half. If `B` has fewer candidates than
 * its half, the unused share is reallocated to `A` (bounded by how
 * many candidates `A` actually has), so `A` isn't starved by a hard
 * half-cap when `B` has nothing left to spend the remainder on.
 *
 * Only `A` can reclaim leftover here, not `B`: whenever there IS
 * leftover, `B` was necessarily capped by its own candidate count
 * (if it weren't, `budgetB` would already equal `total - budgetA`
 * exactly, leaving no leftover to reclaim in the first place), so `B`
 * has nothing further to use regardless.
 */
function splitBudget(
  total: number,
  countA: number,
  countB: number,
): [number, number] {
  const half = Math.ceil(total / 2);
  let budgetA = Math.min(half, countA);
  const budgetB = Math.min(total - budgetA, countB);
  const leftover = total - budgetA - budgetB;
  if (leftover > 0) {
    budgetA += Math.min(leftover, countA - budgetA);
  }
  return [budgetA, budgetB];
}

/**
 * Buckets `candidates` (indices into `points`) into `budget`
 * equal-width buckets spanning `[firstStep, firstStep + span]` by
 * step value, keeping one representative per bucket. Without
 * `isBetter`, the first candidate seen for a bucket wins (used for
 * plain filler, where no single candidate is more "significant" than
 * another). With `isBetter(candidate, currentWinner)`, a later
 * candidate can replace the current winner if it's more significant
 * (used for extrema and eval tiers, so the single most severe spike
 * in a bucket survives rather than whichever happened to be seen
 * first). Returns at most `budget` indices.
 */
function bucketSelect(
  points: LossPoint[],
  candidates: number[],
  budget: number,
  firstStep: number,
  span: number,
  isBetter?: (candidate: number, currentWinner: number) => boolean,
): number[] {
  if (budget <= 0 || candidates.length === 0) return [];
  if (candidates.length <= budget) return candidates;

  const winner: (number | null)[] = Array.from({ length: budget }, () => null);

  for (const idx of candidates) {
    const step = points[idx].step;
    let b = span === 0 ? 0 : Math.floor(((step - firstStep) / span) * budget);
    if (b >= budget) b = budget - 1;
    if (b < 0) b = 0;
    const current = winner[b];
    if (current === null) {
      winner[b] = idx;
    } else if (isBetter?.(idx, current)) {
      winner[b] = idx;
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
 * Output is explicitly sorted by `step` regardless of input order:
 * `Map` preserves insertion (first-occurrence) order, not step order,
 * so a caller that ever appends an out-of-order frame (e.g. after an
 * SSE reconnect replay) would otherwise corrupt the boundary and
 * bucket-width calculations that assume a step-ascending array.
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
  // eslint-disable-next-line unicorn/no-array-sort
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}
