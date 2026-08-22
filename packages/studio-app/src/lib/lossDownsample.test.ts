import { describe, it, expect } from "vitest";
import { compactLossPoints } from "./lossDownsample";
import type { LossPoint } from "../components/jobs/LossChart";

function point(
  step: number,
  loss: number | null,
  evalLoss?: number | null,
): LossPoint {
  return evalLoss === undefined ? { step, loss } : { step, loss, evalLoss };
}

function isSortedByStep(points: LossPoint[]): boolean {
  for (let i = 1; i < points.length; i++) {
    if (points[i].step < points[i - 1].step) return false;
  }
  return true;
}

describe("compactLossPoints", () => {
  it("returns the input (deep-equal, deduped by step) when already at or under targetSize", () => {
    // No longer referentially identical (`toBe`) now that
    // compactLossPoints always merges duplicate steps first, which
    // allocates a fresh array/objects even when no further
    // compaction is needed; the data itself is unchanged when there
    // are no duplicate steps to merge.
    const points = [point(1, 0.5), point(2, 0.4), point(3, 0.3)];
    expect(compactLossPoints(points, 3)).toStrictEqual(points);
    expect(compactLossPoints(points, 10)).toStrictEqual(points);
  });

  it("returns an empty array for empty input", () => {
    expect(compactLossPoints([], 10)).toEqual([]);
  });

  it("returns an empty array when targetSize is 0 or negative", () => {
    const points = [point(1, 0.5), point(2, 0.4)];
    expect(compactLossPoints(points, 0)).toEqual([]);
    expect(compactLossPoints(points, -5)).toEqual([]);
  });

  it("returns only the last point when targetSize is 1", () => {
    const points = [point(1, 0.9), point(2, 0.5), point(3, 0.1)];
    expect(compactLossPoints(points, 1)).toEqual([point(3, 0.1)]);
  });

  it("always preserves the first and last point", () => {
    const points = Array.from({ length: 100 }, (_, i) => point(i, 1 / (i + 1)));
    const result = compactLossPoints(points, 10);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });

  it("preserves every point with a finite evalLoss", () => {
    const points = Array.from({ length: 200 }, (_, i) =>
      i % 37 === 0 ? point(i, 1, 0.8) : point(i, 1),
    );
    const evalSteps = points
      .filter((p) => typeof p.evalLoss === "number")
      .map((p) => p.step);
    const result = compactLossPoints(points, 20);
    const resultEvalSteps = result
      .filter((p) => typeof p.evalLoss === "number")
      .map((p) => p.step);
    expect(resultEvalSteps).toEqual(evalSteps);
  });

  it("preserves local minima and maxima of the loss series", () => {
    // A single sharp spike in the middle of an otherwise flat series.
    const points = Array.from({ length: 50 }, (_, i) =>
      point(i, i === 25 ? 99 : 1),
    );
    const result = compactLossPoints(points, 10);
    expect(result.some((p) => p.step === 25 && p.loss === 99)).toBe(true);
  });

  it("does not flood the must-keep set on a flat/constant loss series", () => {
    // Ties on both sides shouldn't count as an extremum; a constant
    // series should compact down to essentially first/last plus even
    // sampling, not near-full retention.
    const points = Array.from({ length: 1000 }, (_, i) => point(i, 1));
    const result = compactLossPoints(points, 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("keeps output sorted by step (subsequence of input)", () => {
    const points = Array.from({ length: 5000 }, (_, i) =>
      point(i, Math.sin(i / 50)),
    );
    const result = compactLossPoints(points, 500);
    expect(isSortedByStep(result)).toBe(true);
  });

  it("never exceeds targetSize even when must-keep points alone exceed it", () => {
    // Every point carries a finite evalLoss, so the must-keep set is
    // the entire array; the function must still respect the cap by
    // evenly sampling down from the must-keep set itself.
    const points = Array.from({ length: 300 }, (_, i) => point(i, 1, i * 0.01));
    const result = compactLossPoints(points, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });

  it("simulates a long training run: compacting to half the cap repeatedly stays bounded and keeps the run's start visible", () => {
    // Mirrors how JobDetail.tsx would call this: compact to
    // MAX_LOSS_POINTS/2 each time the cap is hit, then keep appending.
    const MAX = 2000;
    let points: LossPoint[] = [];
    for (let step = 0; step < 50_000; step++) {
      points.push(point(step, Math.exp(-step / 10_000)));
      if (points.length > MAX) {
        points = compactLossPoints(points, MAX / 2);
      }
    }
    expect(points.length).toBeLessThanOrEqual(MAX);
    // The very first step of the run must still be present somewhere,
    // which is exactly the bug #215 reports against tail-slicing.
    expect(points.some((p) => p.step === 0)).toBe(true);
    expect(isSortedByStep(points)).toBe(true);
    // Position-based (rather than step-value-bucketed) sampling across
    // many repeated compaction passes geometrically erodes how many
    // representatives the *early* portion of a long run keeps, since
    // each pass gives already-thinned old survivors and freshly
    // appended raw points equal weight by count rather than by the
    // step range they represent. Verified against an earlier,
    // position-based version of this function: after this same 50k
    // step simulation, only steps 0 and 1 survived below step 1,000,
    // jumping straight to roughly step 39,000. These two checks would
    // have failed against that version and must keep passing here.
    const early = points.filter((p) => p.step < 5000);
    expect(early.length).toBeGreaterThan(10);
    const gaps = points.slice(1).map((p, i) => p.step - points[i].step);
    expect(Math.max(...gaps)).toBeLessThan(2500);
  });

  it("treats loss values separated by null-loss frames as still adjacent for extrema detection (fails if extrema detection is removed)", () => {
    // Deliberately tight: only one loss-series slot is available after
    // boundaries and the evalLoss point are accounted for, and the
    // spike is NOT first in array order among the loss-bearing
    // candidates. If extrema detection were disabled or broken, this
    // single slot would go to whichever plain candidate comes first
    // in array order (step 1) instead of the spike (step 3), so this
    // assertion genuinely depends on extremum detection working, not
    // on incidentally surviving via generic filler.
    const points = [
      point(0, 1), // boundary
      point(1, 2), // ordinary point, earlier in array order than the spike
      point(2, null, 0.5), // no loss, only evalLoss
      point(3, 5), // local max relative to steps 1 and 4, across the null-loss gap at step 2
      point(4, 1), // ordinary point after the spike
      point(5, 1), // boundary
    ];
    const result = compactLossPoints(points, 4);
    expect(result.some((p) => p.step === 3 && p.loss === 5)).toBe(true);
  });

  it("preserves both sides of a high-frequency oscillation, not just whichever side wins by array order", () => {
    // A genuinely alternating series (not just noisy-but-trending)
    // makes nearly every interior point a strict local min or max.
    // Without protecting min and max with their own separate budgets,
    // position-sampling the combined extrema set can let one side win
    // almost every bucket purely by array order, aliasing the
    // retained shape into a false broad trend instead of the real
    // back-and-forth.
    const points = Array.from({ length: 41 }, (_, i) =>
      point(i, i % 2 === 0 ? 0 : 10),
    );
    const result = compactLossPoints(points, 10);
    const interior = result.filter((p) => p.step !== 0 && p.step !== 40);
    expect(interior.some((p) => p.loss === 10)).toBe(true);
    expect(interior.some((p) => p.loss === 0)).toBe(true);
  });

  it("prioritizes a sparse evalLoss point over extrema when both compete for a constrained budget", () => {
    // A genuinely alternating loss series makes nearly every interior
    // point a strict local min or max, so the extrema set alone can
    // vastly exceed a small targetSize. A single evalLoss point placed
    // away from any position an even-sample over the combined
    // (boundary + evalLoss + extrema) set would naturally land on
    // would be silently dropped if evalLoss and extrema were sampled
    // together with equal priority. This must not happen: evalLoss is
    // documented as always surviving unless it alone overflows the
    // budget, which a single point never does.
    const points = Array.from({ length: 21 }, (_, i) =>
      i === 7 ? point(i, i % 2, 0.5) : point(i, i % 2),
    );
    const result = compactLossPoints(points, 5);
    expect(result.some((p) => p.step === 7 && p.evalLoss === 0.5)).toBe(true);
  });

  it("merges a step's loss and evalLoss when they arrive as two separate frames, so compaction can't split them (#215 regression)", () => {
    // The trainer can emit a step's training-loss and eval-loss as two
    // distinct SSE frames (see LossChart.tsx's "eval-only frames"
    // comment, which documents this as an explicitly supported
    // shape). Without merging by step first, compaction could keep
    // one frame for a step and drop the other, silently losing
    // whichever field lived only in the dropped frame.
    const points: LossPoint[] = [
      ...Array.from({ length: 4 }, (_, i) => point(i, 1)),
      point(5, 0.7), // loss-only frame for step 5
      point(5, null, 0.3), // later eval-only frame, SAME step
      ...Array.from({ length: 5 }, (_, i) => point(i + 6, 1)),
    ];
    const result = compactLossPoints(points, 4);
    const step5 = result.find((p) => p.step === 5);
    expect(step5).toBeDefined();
    expect(step5?.loss).toBe(0.7);
    expect(step5?.evalLoss).toBe(0.3);
  });

  it("does not let a dense evalLoss series crowd out the training-loss series (#215 regression)", () => {
    // Mirrors a scenario review caught: alternating training-loss-only
    // and eval-only frames across a long run. A flat, un-bucketed
    // priority tier for evalLoss could consume nearly the whole
    // budget before the ordinary loss series ever got a look-in.
    // Bucketing by step value guarantees each region of the run
    // yields at most one representative regardless of which series
    // "wins" that bucket, so neither series can be entirely crowded
    // out by the other.
    const points: LossPoint[] = Array.from(
      { length: 2001 },
      (_, i) =>
        i % 2 === 0
          ? point(i, Math.sin(i / 5)) // training-loss-only frame
          : point(i, null, Math.sin(i / 5)), // eval-only frame
    );
    const result = compactLossPoints(points, 200);
    const trainingLossPoints = result.filter((p) => p.loss !== null);
    // Comfortably more than "just the two boundaries": proves the
    // training-loss series survives compaction meaningfully, not just
    // at the very start and end of the run.
    expect(trainingLossPoints.length).toBeGreaterThan(20);
  });

  it("keeps the most severe spike in a bucket rather than whichever extremum was seen first", () => {
    // A modest local max at step 1 and a genuinely severe spike at
    // step 3 fall into the same bucket under a tight budget (target
    // 3 leaves only a single interior loss slot, forcing a real
    // conflict). Picking merely the first-seen candidate per bucket
    // (rather than the most extreme) would keep the modest one and
    // silently drop the severe spike, exactly the kind of point this
    // preservation exists for.
    const points = Array.from({ length: 11 }, (_, i) => point(i, 1));
    points[1] = point(1, 2); // modest local max
    points[3] = point(3, 100); // severe spike, same bucket as step 1
    const result = compactLossPoints(points, 3);
    expect(result.some((p) => p.step === 3 && p.loss === 100)).toBe(true);
  });

  it("reallocates an under-demanded series' unused budget to the other side rather than capping both at a hard half", () => {
    // A single scarce loss-only point competes against an abundant
    // eval-only series for the shared bucket budget. A hard half-cap
    // (no reallocation) would limit eval to half the budget even
    // though the single loss candidate only needs one slot, leaving
    // the rest unused instead of going to eval. (An earlier version
    // of this test tried to force the same conflict via loss maxima
    // vs minima, but isolated spikes/dips against a flat baseline
    // also flag their immediate shoulder points as extrema, making
    // both categories populous in practice rather than genuinely
    // lopsided; the eval/loss split is directly controllable without
    // that side effect.)
    const points: LossPoint[] = Array.from({ length: 31 }, (_, i) => {
      if (i === 0 || i === 30) return point(i, 999); // boundaries: plain loss only
      if (i === 15) return point(i, 50); // the single scarce loss candidate
      return point(i, null, 1); // abundant eval-only candidates
    });
    const result = compactLossPoints(points, 17);
    const evalRepresentatives = result.filter(
      (p) => typeof p.evalLoss === "number",
    );
    // Hard half of the 15-slot bucket budget would be 8; reallocating
    // the scarce loss series' unused share should give eval 14.
    expect(evalRepresentatives.length).toBe(14);
  });

  it("reclaims stranded capacity for eval when overlap with loss leaves loss under-using its share", () => {
    // Every core interior point (steps 1-8) carries both loss and
    // evalLoss (full overlap). Eval's initial budget is computed
    // before knowing which of loss's candidates it will end up
    // claiming; once eval selects some of the shared points, loss's
    // remaining pool can shrink below what its share of the budget
    // assumed, stranding capacity that eval could have used for its
    // own further candidates instead.
    //
    // Three "empty" interstitial points (no loss, no evalLoss, at
    // fractional steps within the existing range) pad points.length
    // past targetSize without disturbing the first/last step range or
    // any candidate counts, so compaction genuinely runs. (An earlier
    // version of this test had points.length === targetSize, which
    // hit the "already under budget" early-return path and never
    // exercised compaction at all, a flaw both CodeRabbit and cubic
    // independently caught.)
    const points: LossPoint[] = [
      point(0, 1), // boundary
      ...Array.from({ length: 8 }, (_, i) => point(i + 1, 1, 1)),
      point(9, 1), // boundary
      { step: 0.1, loss: null },
      { step: 0.2, loss: null },
      { step: 0.3, loss: null },
    ];
    const result = compactLossPoints(points, 12);
    // Only 10 points here can ever be selected: the 2 boundaries plus
    // the 8 core overlapping candidates (the 3 padding points carry
    // neither loss nor evalLoss, so they can never win any tier and
    // exist purely to push points.length past targetSize so
    // compaction actually runs). 10, not 12, is the true achievable
    // maximum for this data regardless of allocation strategy; this
    // asserts compaction reaches that true ceiling rather than
    // falling short of it due to the eval/loss overlap (verified: eval
    // selects 5 initially, loss's overlap-adjusted share only reaches
    // 3, stranding 2 slots that the reclaim then recovers, exactly
    // filling out the remaining 2 of the 8 core candidates).
    expect(result.length).toBe(10);
  });

  it("prefers a genuine eval-loss extremum over an ordinary eval value in the same bucket", () => {
    // A flat evalLoss baseline with one distinct eval-loss spike.
    // Without preferring eval extrema, the first-seen ordinary value
    // in that spike's bucket could win instead, silently dropping a
    // genuine eval-loss anomaly.
    const points = Array.from({ length: 21 }, (_, i) => point(i, null, 1));
    points[10] = point(10, null, 50); // eval-loss spike
    const result = compactLossPoints(points, 6);
    expect(result.some((p) => p.step === 10 && p.evalLoss === 50)).toBe(true);
  });

  it("keeps output sorted by step even if merged input arrives out of step order", () => {
    // mergeByStep's underlying Map preserves insertion order, not
    // step order; an out-of-order duplicate-step frame (e.g. from an
    // SSE reconnect replay) must not corrupt the boundary or
    // bucket-width calculations that assume a step-ascending array.
    const points: LossPoint[] = [
      point(0, 1),
      point(5, 1),
      point(3, 1), // arrives out of order relative to step 5
      point(2, 1, 0.5),
      point(10, 1),
    ];
    const result = compactLossPoints(points, 3);
    expect(isSortedByStep(result)).toBe(true);
    expect(result[0].step).toBe(0);
    expect(result.at(-1)?.step).toBe(10);
  });

  it("never exceeds targetSize even when eval's own selection under-fills its budget for reasons unrelated to loss overlap", () => {
    // evalLoss candidates are tightly clustered near the start of a
    // much wider overall run (steps 1-20 out of a 0-1000 range), so
    // eval's own first pass under-fills its allotted budget for
    // reasons having nothing to do with overlap with loss. Loss
    // candidates are abundant and spread across the full range. A
    // reclaim design that hands eval the COMBINED eval+loss shortfall
    // (rather than specifically loss's own shortfall) could let
    // eval's second attempt select more points than loss's shortfall
    // actually freed up, pushing the total over targetSize; this
    // reproduces the exact scenario that would trigger that.
    const points: LossPoint[] = [
      point(0, 1), // boundary
      ...Array.from({ length: 20 }, (_, i) => point(i + 1, null, 1)),
      ...Array.from({ length: 91 }, (_, i) => point(50 + i * 10, 1)),
      point(1000, 1), // boundary
    ];
    const targetSize = 30;
    const result = compactLossPoints(points, targetSize);
    expect(result.length).toBeLessThanOrEqual(targetSize);
  });

  it("recovers eval points clustered in a narrow part of a much wider run, not just whichever single bucket they'd share under a global span", () => {
    // 20 evalLoss candidates confined to steps 1-20 within a 0-1000
    // step range. Bucketing against the full outer span would waste
    // nearly all of a 14-slot budget on buckets no candidate could
    // ever occupy, collapsing 20 candidates down to essentially one
    // representative; bucketing against the candidates' own local
    // span should recover close to the full budget instead.
    const points: LossPoint[] = [
      point(0, 1), // boundary
      ...Array.from({ length: 20 }, (_, i) => point(i + 1, null, 1)),
      ...Array.from({ length: 91 }, (_, i) => point(50 + i * 10, 1)),
      point(1000, 1), // boundary
    ];
    const result = compactLossPoints(points, 30);
    const evalRepresentatives = result.filter(
      (p) => typeof p.evalLoss === "number",
    );
    // Comfortably more than the single point a global-span collapse
    // would leave; proves local-span bucketing is doing real work.
    expect(evalRepresentatives.length).toBeGreaterThan(10);
  });

  it("backfills budget when candidates form separate clusters with a large gap between them", () => {
    // Eval-only candidates in two distinct clusters (steps 1-20 and
    // steps 900-920) within a much wider overall run. Local-span
    // bucketing alone (spanning only the candidates' own min/max
    // step) still leaves buckets that fall in the gap between the two
    // clusters permanently empty, since no candidate's step ever maps
    // there; without backfilling those empty buckets from leftover
    // candidates, most of the budget goes unused despite having far
    // more candidates than the budget requires.
    const points: LossPoint[] = [point(0, 1)];
    for (let s = 1; s <= 20; s++) points.push(point(s, null, 1));
    for (let s = 21; s < 900; s += 20) points.push(point(s, 1));
    for (let s = 900; s <= 920; s++) points.push(point(s, null, 1));
    points.push(point(1000, 1));

    const result = compactLossPoints(points, 40);
    const evalRepresentatives = result.filter(
      (p) => typeof p.evalLoss === "number",
    );
    // With 41 eval candidates and a generous share of the 38-slot
    // bucket budget, backfilling should recover most of them rather
    // than collapsing to just the couple of points a single naive
    // bucket per cluster boundary would leave.
    expect(evalRepresentatives.length).toBeGreaterThan(15);
  });
});
