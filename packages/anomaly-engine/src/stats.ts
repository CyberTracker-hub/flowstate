/**
 * Small, dependency-free robust statistics helpers.
 *
 * Every function here is total: it never returns NaN or +/-Infinity. Callers
 * get `null` when a quantity cannot be computed, so "unknown" can never be
 * mistaken for a real number further down the pipeline.
 */

/** Robust z-scores are clamped to this magnitude to avoid overflow-like values. */
export const Z_CAP = 20;

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** Keep only finite numbers, dropping null/undefined/NaN/Infinity. */
export function finiteValues(xs: ReadonlyArray<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const x of xs) if (isFiniteNumber(x)) out.push(x);
  return out;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) return null;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1];
  if (lo === undefined) return null;
  return lo + (hi - lo) / 2;
}

/** Median absolute deviation around the sample median. */
export function mad(xs: readonly number[]): number | null {
  const med = median(xs);
  if (med === null) return null;
  return median(xs.map((x) => Math.abs(x - med)));
}

function meanAbsDev(xs: readonly number[], center: number): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += Math.abs(x - center);
  return sum / xs.length;
}

/**
 * Robust z-score of `x` against `sample`: (x - median) / (1.4826 * MAD).
 *
 * When MAD is zero (more than half the sample is identical) we fall back to
 * the mean absolute deviation (scaled by 1.2533). When the sample has no
 * dispersion at all, the result is 0 if x equals the median and +/-Z_CAP
 * otherwise. The result is always clamped to [-Z_CAP, Z_CAP].
 */
export function robustZ(x: number, sample: readonly number[]): number | null {
  if (!isFiniteNumber(x)) return null;
  const med = median(sample);
  if (med === null) return null;
  const m = mad(sample) ?? 0;
  let scale = 1.4826 * m;
  if (scale <= 0) scale = 1.2533 * meanAbsDev(sample, med);
  if (scale <= 0) {
    if (x === med) return 0;
    return x > med ? Z_CAP : -Z_CAP;
  }
  return clamp((x - med) / scale, -Z_CAP, Z_CAP);
}

/**
 * num / max(den, floor). `floor` must be > 0; it prevents division by zero
 * and stops microscopic baselines from producing meaningless huge ratios.
 */
export function flooredRatio(num: number, den: number, floor: number): number | null {
  if (!isFiniteNumber(num) || !isFiniteNumber(den) || !(floor > 0)) return null;
  const ratio = num / Math.max(den, floor);
  return Number.isFinite(ratio) ? ratio : null;
}

/** Linear map of x from [lo, hi] onto [0, 1], clamped. */
export function linScale(x: number, lo: number, hi: number): number {
  if (!isFiniteNumber(x) || !(hi > lo)) return 0;
  return clamp((x - lo) / (hi - lo), 0, 1);
}

/** Logarithmic map of x from [lo, hi] onto [0, 1], clamped. Requires 0 < lo < hi. */
export function logScale(x: number, lo: number, hi: number): number {
  if (!isFiniteNumber(x) || !(lo > 0) || !(hi > lo)) return 0;
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  return clamp((Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)), 0, 1);
}
