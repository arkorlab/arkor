import type { LossPoint } from "../components/jobs/LossChart";

/**
 * Compacts `points` down to at most `targetSize` representatives.
 *
 * Passes, each protecting a category from being crowded out by
 * another that competes for the same step-value buckets:
 *
 * 1. Merge duplicate `step`s first (a later frame's non-null fields
 *    win, matching `LossChart`'s own by-step merge exactly), sorting
 *    the result by step. Without merging, a step whose training-loss
 *    and eval-loss arrive as two separate frames (an explicitly
 *    supported shape: see `LossChart.tsx`'s "eval-only frames"
 *    comment) could have compaction keep one frame and drop the
 *    other. Without the sort, `Map` insertion order (not step order)
 *    could corrupt the boundary and bucket-width calculations below
 *    if an out-of-order frame ever arrived (e.g. an SSE reconnect
 *    replay).
 * 2. Split the remaining budget (after 2 slots reserved for the hard
 *    first/last boundaries) between the `evalLoss` series and the
 *    `loss` series. Each gets up to half; if one series has fewer
 *    candidates than its half, the unused share flows to the other.
 *    Afterward, if loss's own allotted share (after excluding points
 *    eval already claimed) goes partly unused because too few loss
 *    candidates remain, that specific shortfall (and only that
 *    shortfall, not any shortfall in eval's own initial pass) is
 *    handed back to eval. Scoping the reclaim to loss's own shortfall
 *    specifically, rather than the combined gap between the budget
 *    and however many points both sides ended up selecting, keeps
 *    the total provably bounded at `targetSize`: if eval's own first
 *    pass under-filled its budget for an unrelated reason (candidates
 *    clustering within a narrow part of the step range, independent
 *    of any loss overlap), a broader reclaim could hand eval enough
 *    extra budget that its second attempt selects more points than
 *    loss's shortfall actually freed up, pushing the total over
 *    `targetSize`.
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
 *    for loss minima, the lowest; for eval, a genuine local extremum
 *    over an ordinary value; for plain filler, first-seen. Bucket
 *    boundaries span each category's OWN candidates' step range, not
 *    the overall run's step range: a category whose candidates
 *    happen to cluster within a narrow part of a much wider overall
 *    range (e.g. eval-only frames confined to a run's early portion)
 *    would otherwise waste most of its budget on buckets that no
 *    candidate could ever fall into, under-filling even when its
 *    budget was otherwise sufficient.
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

  // Local extrema of the `evalLoss` series, same algorithm as above.
  // Used only as an in-bucket preference (an eval extremum beats an
  // ordinary eval value competing for the same bucket), not a
  // separate budget split like loss's max/min: without this, a
  // genuine eval-loss anomaly could be dropped in favor of an
  // ordinary value that merely happened to be seen first.
  const evalIndicesFull: number[] = [];
  for (const [i, point] of merged.entries()) {
    if (typeof point.evalLoss === "number" && Number.isFinite(point.evalLoss)) {
      evalIndicesFull.push(i);
    }
  }
  const evalIsExtremum: boolean[] = Array.from(
    { length: merged.length },
    () => false,
  );
  for (let k = 1; k < evalIndicesFull.length - 1; k++) {
    const idx = evalIndicesFull[k];
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
    if (isMax || isMin) evalIsExtremum[idx] = true;
  }

  // Split the shared budget between the two series, each getting up
  // to half, with either side's unused share flowing to the other
  // (based on raw candidate counts; loss's *actual* budget below is
  // then adjusted for the overlap exclusion just after).
  const [evalBudget] = splitBudget(
    bucketCount,
    evalCandidates.length,
    lossCandidates.length,
  );
  const evalSelected = bucketSelect(
    merged,
    evalCandidates,
    evalBudget,
    (a, b) => evalIsExtremum[a] && !evalIsExtremum[b],
  );
  const evalSelectedSet = new Set(evalSelected);

  // Exclude anything already claimed by the eval tier so its budget
  // isn't wasted re-selecting a point the output already contains.
  const lossCandidatesRemaining = lossCandidates.filter(
    (i) => !evalSelectedSet.has(i),
  );
  const lossAllottedBudget = bucketCount - evalSelected.length;
  const lossBudget = Math.min(
    lossAllottedBudget,
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
    (a, b) => (merged[a].loss ?? -Infinity) > (merged[b].loss ?? -Infinity),
  );
  const minSelected = bucketSelect(
    merged,
    minCandidates,
    minBudget,
    (a, b) => (merged[a].loss ?? Infinity) < (merged[b].loss ?? Infinity),
  );
  const plainBudget = Math.min(
    lossBudget - maxSelected.length - minSelected.length,
    plainCandidates.length,
  );
  const plainSelected = bucketSelect(merged, plainCandidates, plainBudget);

  const lossFinalSelected = [...maxSelected, ...minSelected, ...plainSelected];
  const lossFinalSelectedSet = new Set(lossFinalSelected);

  // Reclaim loss's own shortfall (how much of ITS allotted share it
  // couldn't spend because too few candidates remained after the
  // overlap exclusion) back to eval. This is deliberately scoped to
  // loss's shortfall specifically, not the combined eval+loss gap
  // against `bucketCount`: see the module doc for why using the wider
  // gap could push the total over `targetSize` when eval's own first
  // pass under-filled its budget for an unrelated reason.
  const lossShortfall = lossAllottedBudget - lossFinalSelected.length;
  const evalPoolForReclaim = evalCandidates.filter(
    (i) => !lossFinalSelectedSet.has(i),
  );
  const finalEvalSelected =
    lossShortfall > 0
      ? bucketSelect(
          merged,
          evalPoolForReclaim,
          Math.min(
            evalSelected.length + lossShortfall,
            evalPoolForReclaim.length,
          ),
          (a, b) => evalIsExtremum[a] && !evalIsExtremum[b],
        )
      : evalSelected;

  const selected = new Set<number>([0, merged.length - 1]);
  for (const i of finalEvalSelected) selected.add(i);
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
 * Buckets `candidates` (indices into `points`, assumed already in
 * step-ascending order) into `budget` equal-width buckets by step
 * value, keeping one representative per bucket. Bucket boundaries
 * span `candidates`' OWN step range (from `points[candidates[0]]` to
 * `points[candidates.at(-1)]`), not any wider range the caller might
 * conceptually care about: if this category's candidates happen to
 * cluster within a narrow part of a much wider overall step range, a
 * shared/global span would waste most of `budget`'s buckets on
 * regions no candidate could ever occupy. Scoping each category's own
 * bucketing to its own candidates keeps `budget` fully usable
 * regardless of how that category happens to be distributed.
 *
 * Without `isBetter`, the first candidate seen for a bucket wins
 * (used for plain filler, where no single candidate is more
 * "significant" than another). With `isBetter(candidate,
 * currentWinner)`, a later candidate can replace the current winner
 * if it's more significant (used for extrema and eval tiers, so the
 * single most severe spike in a bucket survives rather than
 * whichever happened to be seen first). Returns at most `budget`
 * indices.
 */
function bucketSelect(
  points: LossPoint[],
  candidates: number[],
  budget: number,
  isBetter?: (candidate: number, currentWinner: number) => boolean,
): number[] {
  if (budget <= 0 || candidates.length === 0) return [];
  if (candidates.length <= budget) return candidates;

  const firstStep = points[candidates[0]].step;
  const lastStep = points[candidates.at(-1) ?? 0].step;
  const span = lastStep - firstStep;

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

  // If candidates cluster into distinct, widely-separated groups (not
  // just one dense cluster), the buckets spanning the gap between
  // groups can end up with no candidate ever mapping into them,
  // leaving the budget under-used even though there are enough
  // candidates overall to fill it. Backfill any such empty slots from
  // whichever candidates didn't win a bucket of their own; since
  // `candidates.length > budget` here (checked above), there are
  // always at least as many leftover candidates as empty slots.
  const selected = new Set<number>();
  for (const idx of winner) if (idx !== null) selected.add(idx);
  let emptySlots = 0;
  for (const idx of winner) if (idx === null) emptySlots++;
  if (emptySlots > 0) {
    const unselected = candidates.filter((idx) => !selected.has(idx));
    let fillIndex = 0;
    for (let b = 0; b < budget && fillIndex < unselected.length; b++) {
      if (winner[b] === null) {
        winner[b] = unselected[fillIndex];
        fillIndex++;
      }
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
