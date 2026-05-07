import { describe, it, expect } from "vitest";
import {
  mean,
  variance,
  stddev,
  percentile,
  confidenceInterval95,
  summarize,
} from "./stats";

describe("stats", () => {
  describe("mean", () => {
    it("averages a non-empty array", () => {
      expect(mean([1, 2, 3, 4])).toBe(2.5);
    });

    it("returns NaN for an empty array — caller must filter", () => {
      // Caller-side responsibility: stats are gated on at-least-one
      // numeric loss point, so we don't fabricate a value here.
      expect(Number.isNaN(mean([]))).toBe(true);
    });
  });

  describe("variance / stddev", () => {
    it("uses Bessel correction (divides by n-1)", () => {
      // Sample variance of [1,2,3,4,5] is 10 / 4 = 2.5; population
      // variance would be 10 / 5 = 2. We explicitly want the unbiased
      // sample estimate so stats match pandas' default and numpy /
      // scipy when configured with `ddof=1` (numpy's own default for
      // `var` / `std` is `ddof=0`, i.e. population).
      expect(variance([1, 2, 3, 4, 5])).toBeCloseTo(2.5, 10);
      expect(stddev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 10);
    });

    it("returns 0 for a single-sample input rather than NaN", () => {
      expect(variance([1.5])).toBe(0);
      expect(stddev([1.5])).toBe(0);
    });

    it("returns NaN for an empty array — consistent with mean([])", () => {
      // Returning 0 here would silently mask "no data" as "no spread";
      // NaN is the same convention `mean` and `percentile` use, so all
      // three short-circuit the same way.
      expect(Number.isNaN(variance([]))).toBe(true);
      expect(Number.isNaN(stddev([]))).toBe(true);
    });
  });

  describe("percentile", () => {
    it("matches numpy linear interpolation at the 90th and 95th percentile", () => {
      // For [1..10], q=0.9 → rank 8.1 → 9 + 0.1*(10-9) = 9.1.
      // q=0.95 → rank 8.55 → 9 + 0.55*(10-9) = 9.55.
      const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(percentile(xs, 0.9)).toBeCloseTo(9.1, 10);
      expect(percentile(xs, 0.95)).toBeCloseTo(9.55, 10);
    });

    it("does not mutate the input array (sort works on a copy)", () => {
      const xs = [3, 1, 2];
      percentile(xs, 0.5);
      expect(xs).toEqual([3, 1, 2]);
    });

    it("returns the single value for a one-element input", () => {
      expect(percentile([42], 0.95)).toBe(42);
    });

    it("clamps q to [0, 1] so out-of-range values return min / max", () => {
      // Out-of-range q would otherwise compute lo/hi outside the
      // sorted-array bounds and trip the non-null assertions inside
      // the function. Clamping pins `q < 0` to the min and `q > 1`
      // to the max element instead of throwing.
      const xs = [10, 20, 30, 40];
      expect(percentile(xs, -0.5)).toBe(10);
      expect(percentile(xs, 1.5)).toBe(40);
    });
  });

  describe("confidenceInterval95", () => {
    it("uses the t-distribution for small samples", () => {
      // n=5, mean=3, stddev=√2.5, t(df=4)=2.776
      // half-width = 2.776 * √2.5 / √5
      const expected = (2.776 * Math.sqrt(2.5)) / Math.sqrt(5);
      const ci = confidenceInterval95([1, 2, 3, 4, 5]);
      expect(ci).toBeCloseTo(expected, 6);
    });

    it("falls back to the normal-distribution z=1.96 for n > 31", () => {
      // 31 identical values + one outlier (n=32, df=31) so stddev is
      // non-zero. The actual numbers don't matter; what matters is
      // that df is above the t-table cutoff (30) and we exercise the
      // z=1.96 fallback path.
      const xs = Array.from({ length: 31 }, () => 1).concat([2]);
      const ci = confidenceInterval95(xs);
      const sd = stddev(xs);
      expect(ci).toBeCloseTo(1.96 * (sd / Math.sqrt(xs.length)), 6);
    });

    it("returns 0 for n ≤ 1 (no spread to bound)", () => {
      expect(confidenceInterval95([])).toBe(0);
      expect(confidenceInterval95([7])).toBe(0);
    });
  });

  describe("summarize", () => {
    it("returns the full LossStats bundle", () => {
      const s = summarize([1, 2, 3, 4, 5]);
      expect(s.count).toBe(5);
      expect(s.mean).toBe(3);
      expect(s.variance).toBeCloseTo(2.5, 10);
      expect(s.stddev).toBeCloseTo(Math.sqrt(2.5), 10);
      expect(s.ci95HalfWidth).toBeGreaterThan(0);
      expect(s.p90).toBeCloseTo(4.6, 10);
      expect(s.p95).toBeCloseTo(4.8, 10);
    });
  });
});
