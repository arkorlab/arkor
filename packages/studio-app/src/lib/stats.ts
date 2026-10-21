// Lightweight numeric helpers used by the loss-chart advanced panel.
// All inputs are assumed to be finite numbers; callers filter `null` /
// non-numeric points beforehand.

export interface LossStats {
  count: number;
  mean: number;
  variance: number;
  stddev: number;
  /**
   * Half-width of the 95 % confidence interval for the mean (i.e. the
   * `±` term, not the full interval width or an upper/lower bound). The
   * UI renders this directly as `mean ± ci95HalfWidth`.
   */
  ci95HalfWidth: number;
  p90: number;
  p95: number;
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Sample variance (Bessel-corrected, divides by n-1) so the stddev /
// CI we report match the unbiased estimate stats packages produce.
// Empty input returns NaN (consistent with `mean([])` / `percentile([])`),
// so callers don't silently treat a no-data state as zero spread.
// Single-sample input has no spread to estimate, so we report 0.
export function variance(values: number[]): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return 0;
  const m = mean(values);
  let sq = 0;
  for (const v of values) {
    const d = v - m;
    sq += d * d;
  }
  return sq / (n - 1);
}

export function stddev(values: number[]): number {
  return Math.sqrt(variance(values));
}

// Linear-interpolated percentile lookup against an already-sorted
// array. Extracted so `summarize()` can sort once and pull both
// p90 and p95 from the same sorted view instead of sorting twice.
function percentileFromSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, q));
  const rank = clamped * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// Linear-interpolated percentile: same convention as numpy's default
// (`linear`). `q` is clamped to [0, 1]; out-of-range values would
// otherwise compute lo/hi outside the sorted-array bounds and trip the
// non-null assertions below.
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  // `[...values].sort(...)` (not `.toSorted()`) because the Studio
  // SPA's tsconfig pins `target: ES2022` and `Array.prototype.toSorted`
  // is ES2023; Vite/esbuild won't polyfill it, so older evergreen
  // browsers would throw at runtime.
  // oxfmt-ignore
  // eslint-disable-next-line unicorn/no-array-sort
  return percentileFromSorted([...values].sort((a, b) => a - b), q);
}

// Two-tailed 95% Student's t critical values for df 1..30. For df > 30
// we use 1.96 (the normal-distribution limit), close enough for the
// kinds of step counts a training run produces.
const T_95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201,
  2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
  2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function tCritical95(df: number): number {
  if (df < 1) return Number.NaN;
  if (df <= 30) return T_95[df - 1];
  return 1.96;
}

// Half-width of the 95% confidence interval for the mean: t * (s / √n).
// Empty input returns NaN (consistent with `mean([])` / `variance([])`
// / `percentile([])`), so callers can't misread "no data" as "zero
// uncertainty around an undefined mean". A single-sample input keeps
// `0`: there is a defined mean (the sample itself) but no spread to
// bound it, so reporting half-width 0 is accurate.
export function confidenceInterval95(values: number[]): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return 0;
  const sd = stddev(values);
  return tCritical95(n - 1) * (sd / Math.sqrt(n));
}

// Single-pass aggregator. The standalone `mean` / `variance` /
// `stddev` / `confidenceInterval95` / `percentile` helpers compose
// each other, which means a naive `summarize()` ends up walking the
// array four times and sorting it twice. This version walks once for
// mean, once for the squared-deviation sum, and sorts a single time
// to derive both p90 and p95: material when `advanced` is on and
// `points` updates land every training.log frame.
export function summarize(values: number[]): LossStats {
  const n = values.length;
  if (n === 0) {
    return {
      count: 0,
      mean: Number.NaN,
      variance: Number.NaN,
      stddev: Number.NaN,
      ci95HalfWidth: Number.NaN,
      p90: Number.NaN,
      p95: Number.NaN,
    };
  }

  let sum = 0;
  for (const v of values) sum += v;
  const m = sum / n;

  let varv: number;
  if (n === 1) {
    varv = 0;
  } else {
    let sq = 0;
    for (const v of values) {
      const d = v - m;
      sq += d * d;
    }
    varv = sq / (n - 1);
  }
  const sd = Math.sqrt(varv);
  const ciHalf = n <= 1 ? 0 : tCritical95(n - 1) * (sd / Math.sqrt(n));

  // ES2022 target: see `percentile()` above for the toSorted rationale.
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...values].sort((a, b) => a - b);

  return {
    count: n,
    mean: m,
    variance: varv,
    stddev: sd,
    ci95HalfWidth: ciHalf,
    p90: percentileFromSorted(sorted, 0.9),
    p95: percentileFromSorted(sorted, 0.95),
  };
}

// Streaming counterpart to `summarize()`. `summarize()` derives stats
// from whatever array a caller currently holds; for a live training
// run whose displayed points get compacted (see lossDownsample.ts),
// that array intentionally over-represents extrema relative to the
// full run, biasing mean/variance/percentiles once compaction has run
// at least once. RunningStats instead accumulates incrementally as
// each raw value arrives, independent of any compaction applied to
// the array used for charting, so these stats stay accurate for the
// entire run regardless of how long it gets.
//
// mean/variance are computed exactly via Welford's online algorithm
// (no array ever needs to be retained for these). Percentiles can't
// be computed exactly without retaining every value, so they're
// estimated from a bounded reservoir sample (Algorithm R): a value
// uniformly representative of the full run's distribution, capped at
// `reservoirSize` entries regardless of how many values are seen.
const DEFAULT_RESERVOIR_SIZE = 2000;

export interface RunningStats {
  count: number;
  mean: number;
  /** Sum of squared deviations from the running mean (Welford's M2). */
  m2: number;
  reservoir: number[];
  reservoirSize: number;
  /**
   * The reservoir index the most recent updateRunningStats call
   * touched (pushed to while filling, or replaced via an Algorithm R
   * hit once full), or null if that call was a miss (full reservoir,
   * value not sampled in). Exists so correctRunningStats can replace
   * the exact right slot when a caller corrects the most recent
   * value, without needing to re-derive (unreliably, after the fact)
   * where or whether it landed in the reservoir.
   */
  lastReservoirIndex: number | null;
}

export function createRunningStats(
  reservoirSize: number = DEFAULT_RESERVOIR_SIZE,
): RunningStats {
  if (!Number.isInteger(reservoirSize) || reservoirSize < 1) {
    throw new RangeError(
      `reservoirSize must be a positive integer, got ${reservoirSize}`,
    );
  }
  return {
    count: 0,
    mean: 0,
    m2: 0,
    reservoir: [],
    reservoirSize,
    lastReservoirIndex: null,
  };
}

// Pure: returns a new accumulator rather than mutating `stats`, and
// never mutates `stats.reservoir` either. This matters for two
// reasons. First, correctness: React requires a setState updater to
// be pure, since React (particularly in Strict Mode) can invoke it
// twice to detect exactly this kind of side effect; mutating the
// previous state in place would corrupt the second invocation's
// input. Second, performance: once the reservoir is full, most
// updates don't touch it at all (only a ~reservoirSize/count chance
// per call), so cloning it defensively on every call, as a mutating
// version of this function would force callers to do, wastes a full
// array copy on the vast majority of calls for a long-running job.
// Here, the reservoir array reference is reused untouched on that
// common path, and only cloned in the two cases where it actually
// changes: while still filling up, or on the comparatively rare
// occasions the random draw below replaces an existing entry.
export function updateRunningStats(
  stats: RunningStats,
  value: number,
): RunningStats {
  const count = stats.count + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / count;
  const delta2 = value - mean;
  const m2 = stats.m2 + delta * delta2;

  let reservoir = stats.reservoir;
  let lastReservoirIndex: number | null;
  if (reservoir.length < stats.reservoirSize) {
    reservoir = [...reservoir, value];
    lastReservoirIndex = reservoir.length - 1;
  } else {
    // Algorithm R: each of the `count` values seen so far has an
    // equal 1/count chance of being the one currently occupying any
    // given reservoir slot.
    const j = Math.floor(Math.random() * count);
    if (j < stats.reservoirSize) {
      reservoir = [...reservoir];
      reservoir[j] = value;
      lastReservoirIndex = j;
    } else {
      lastReservoirIndex = null;
    }
  }

  return {
    count,
    mean,
    m2,
    reservoir,
    reservoirSize: stats.reservoirSize,
    lastReservoirIndex,
  };
}

// Snapshots a RunningStats accumulator into the same LossStats shape
// `summarize()` produces, so both can feed the same display code.
// `count` reports the true total values ever seen (mean/variance are
// exact for that full count); p90/p95 are estimated from the bounded
// reservoir, which is a uniform sample of that same full history.
export function finalizeRunningStats(stats: RunningStats): LossStats {
  const n = stats.count;
  if (n === 0) {
    return {
      count: 0,
      mean: Number.NaN,
      variance: Number.NaN,
      stddev: Number.NaN,
      ci95HalfWidth: Number.NaN,
      p90: Number.NaN,
      p95: Number.NaN,
    };
  }
  const varv = n === 1 ? 0 : stats.m2 / (n - 1);
  const sd = Math.sqrt(varv);
  const ciHalf = n <= 1 ? 0 : tCritical95(n - 1) * (sd / Math.sqrt(n));
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...stats.reservoir].sort((a, b) => a - b);
  return {
    count: n,
    mean: stats.mean,
    variance: varv,
    stddev: sd,
    ci95HalfWidth: ciHalf,
    p90: percentileFromSorted(sorted, 0.9),
    p95: percentileFromSorted(sorted, 0.95),
  };
}

// Reverses a single updateRunningStats(stats, value) call, assuming
// `value` was the most recently added sample: this only holds if no
// other update has happened in between, which is exactly the shape
// callers need it for (computing the corrected moments in
// correctRunningStats below, which handles the reservoir separately;
// see its own doc comment for why).
function removeMostRecentRunningStat(
  stats: RunningStats,
  value: number,
): RunningStats {
  const count = stats.count - 1;
  if (count <= 0) {
    return {
      count: 0,
      mean: 0,
      m2: 0,
      reservoir: stats.reservoir,
      reservoirSize: stats.reservoirSize,
      lastReservoirIndex: stats.lastReservoirIndex,
    };
  }
  const mean = (stats.mean * stats.count - value) / count;
  const delta = value - mean;
  const delta2 = value - stats.mean;
  const m2 = stats.m2 - delta * delta2;
  return {
    count,
    mean,
    m2,
    reservoir: stats.reservoir,
    reservoirSize: stats.reservoirSize,
    lastReservoirIndex: stats.lastReservoirIndex,
  };
}

// Corrects the most recently added sample from `oldValue` to
// `newValue`, for callers whose source can emit a revised value for
// something already added (e.g. a training.log frame correcting an
// already-reported loss for the same step). Restores mean/variance/CI
// to exactly what they'd be had `newValue` been added in the first
// place instead of `oldValue` (via removeMostRecentRunningStat, pure
// moment math with no reservoir side effects of its own).
//
// Uses `stats.lastReservoirIndex` (set by the updateRunningStats call
// that added `oldValue`) to replace the exact right slot rather than
// re-deriving where it landed after the fact: an earlier version
// tried to infer this from whether the reservoir "looked" full yet,
// which undercounted the still-filling case at its own boundary (the
// value that completes filling leaves reservoir.length already equal
// to reservoirSize) and couldn't handle an Algorithm R hit once truly
// full at all, leaving a stale entry that could dominate p90/p95
// rather than just mildly bias them. Tracking the index directly
// handles the fill, hit, and miss cases uniformly: replace at that
// index if it's non-null, otherwise (a miss) leave the reservoir
// untouched, since `oldValue` was never actually sampled into it.
export function correctRunningStats(
  stats: RunningStats,
  oldValue: number,
  newValue: number,
): RunningStats {
  const removed = removeMostRecentRunningStat(stats, oldValue);
  const count = removed.count + 1;
  const delta = newValue - removed.mean;
  const mean = removed.mean + delta / count;
  const delta2 = newValue - mean;
  const m2 = removed.m2 + delta * delta2;
  let reservoir = stats.reservoir;
  if (stats.lastReservoirIndex !== null) {
    reservoir = [...stats.reservoir];
    reservoir[stats.lastReservoirIndex] = newValue;
  }
  return {
    count,
    mean,
    m2,
    reservoir,
    reservoirSize: stats.reservoirSize,
    lastReservoirIndex: stats.lastReservoirIndex,
  };
}
