/**
 * Change-point detection — "your routine shifted around <date>."
 *
 * Where CUSUM (already shipped as `muse pattern lapsed`) flags that a level was
 * breached, change-point detection finds WHERE a series switched from one regime
 * to another — the onset of a new normal (the deterministic, offline cousin of
 * Bayesian online change-point detection; Adams & MacKay 2007). It scans every
 * split, scores the standardized gap between the before-mean and after-mean
 * (weighted by the smaller segment so a one-off endpoint can't masquerade as a
 * regime), and returns the most significant shift — or null when the series is
 * steady. Pure + deterministic.
 */

import { median } from "./median.js";

const DEFAULT_MIN_SEGMENT = 3;
const DEFAULT_THRESHOLD = 1.0; // the two regimes' means must differ by ≥ ~1 robust sd

export interface ChangePoint {
  /** Index of the first sample of the NEW regime. */
  readonly index: number;
  readonly beforeMean: number;
  readonly afterMean: number;
  /** |afterMean - beforeMean| in robust-sd units. */
  readonly magnitude: number;
  readonly direction: "up" | "down";
}

export interface ChangePointOptions {
  /** Each regime must have at least this many samples. Default 3. */
  readonly minSegment?: number;
  /** Minimum standardized gap to count as a real shift. Default 1.0. */
  readonly threshold?: number;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Robust scale of the series: MAD → sd estimate, falling back to mean-abs-dev. */
function robustScale(values: readonly number[]): number {
  const med = median([...values].sort((a, b) => a - b));
  const dev = values.map((value) => Math.abs(value - med));
  const mad = median([...dev].sort((a, b) => a - b)) / 0.6745;
  if (mad > 0) {
    return mad;
  }
  const meanAbsDev = mean(dev) / 0.7979;
  return meanAbsDev;
}

/**
 * The single most significant regime shift in `values`, or null when the series
 * is too short or steady. The returned `index` is the first sample of the new
 * regime.
 */
export function detectChangePoint(values: readonly number[], options: ChangePointOptions = {}): ChangePoint | null {
  const minSegment = Number.isFinite(options.minSegment) ? Math.max(1, Math.trunc(options.minSegment!)) : DEFAULT_MIN_SEGMENT;
  const threshold = Number.isFinite(options.threshold) ? Math.max(0, options.threshold!) : DEFAULT_THRESHOLD;
  const n = values.length;
  if (n < 2 * minSegment) {
    return null;
  }
  const scale = robustScale(values);
  if (scale === 0) {
    return null; // perfectly steady — no regime to find
  }
  let best: { index: number; before: number; after: number; weightedGap: number } | undefined;
  for (let i = minSegment; i <= n - minSegment; i++) {
    const before = mean(values.slice(0, i));
    const after = mean(values.slice(i));
    const weightedGap = Math.abs(after - before) * Math.sqrt(Math.min(i, n - i));
    if (!best || weightedGap > best.weightedGap) {
      best = { after, before, index: i, weightedGap };
    }
  }
  if (!best) {
    return null;
  }
  const magnitude = Math.abs(best.after - best.before) / scale;
  if (magnitude < threshold) {
    return null;
  }
  return {
    afterMean: best.after,
    beforeMean: best.before,
    direction: best.after >= best.before ? "up" : "down",
    index: best.index,
    magnitude
  };
}
