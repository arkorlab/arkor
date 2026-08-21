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
  it("returns the input untouched when already at or under targetSize", () => {
    const points = [point(1, 0.5), point(2, 0.4), point(3, 0.3)];
    expect(compactLossPoints(points, 3)).toBe(points);
    expect(compactLossPoints(points, 10)).toBe(points);
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
  });

  it("treats loss values separated by null-loss frames as still adjacent for extrema detection", () => {
    // targetSize is large enough for both the evalLoss point (step 1)
    // and the extremum (step 2) to fit without competing for the same
    // slot; see the priority-tier test below for that competing case.
    const points = [
      point(0, 1),
      point(1, null, 0.5), // no loss, only evalLoss
      point(2, 5), // local max relative to steps 0 and 3
      point(3, 1),
      point(4, 1),
      point(5, 1),
    ];
    const result = compactLossPoints(points, 5);
    expect(result.some((p) => p.step === 2 && p.loss === 5)).toBe(true);
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
});
