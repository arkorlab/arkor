// Lightweight numeric helpers used by the loss-chart advanced panel.
// All inputs are assumed to be finite numbers; callers filter `null` /
// non-numeric points beforehand.

export interface LossStats {
  count: number;
  mean: number;
  variance: number;
  stddev: number;
  ci95: number;
  p90: number;
  p95: number;
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Sample variance (Bessel-corrected, divides by n-1) so the stddev /
// CI we report match the unbiased estimate stats packages produce.
// Single-sample input has no spread, so we report 0 instead of NaN.
export function variance(values: number[]): number {
  const n = values.length;
  if (n <= 1) return 0;
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

// Linear-interpolated percentile — same convention as numpy's default
// (`linear`). `q` is in [0, 1].
export function percentile(values: number[], q: number): number {
  const n = values.length;
  if (n === 0) return NaN;
  if (n === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = q * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

// Two-tailed 95% Student's t critical values for df 1..30. For df > 30
// we use 1.96 (the normal-distribution limit) — close enough for the
// kinds of step counts a training run produces.
const T_95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571,
  2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131,
  2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060,
  2.056, 2.052, 2.048, 2.045, 2.042,
];

function tCritical95(df: number): number {
  if (df < 1) return NaN;
  if (df <= 30) return T_95[df - 1]!;
  return 1.96;
}

// Half-width of the 95% confidence interval for the mean: t * (s / √n).
// Returns 0 for n ≤ 1 since a single sample has no spread to bound.
export function confidenceInterval95(values: number[]): number {
  const n = values.length;
  if (n <= 1) return 0;
  const sd = stddev(values);
  return tCritical95(n - 1) * (sd / Math.sqrt(n));
}

export function summarize(values: number[]): LossStats {
  return {
    count: values.length,
    mean: mean(values),
    variance: variance(values),
    stddev: stddev(values),
    ci95: confidenceInterval95(values),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
  };
}
