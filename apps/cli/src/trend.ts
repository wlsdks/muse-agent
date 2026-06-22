/**
 * Trend detection — the Mann-Kendall test (Mann, "Nonparametric tests against
 * trend", Econometrica 13(3):245-259, 1945; Kendall, "Rank Correlation Methods",
 * 1975), the standard non-parametric test for a monotonic trend in a time-ordered
 * series — widely used in environmental statistics (river flows, temperatures)
 * precisely because it makes NO assumption about the distribution and is robust to
 * outliers. For a personal tracking column (weight, spending, mood) it answers: is
 * this going UP or DOWN, or just wandering? The magnitude is Sen's slope (the
 * median of all pairwise slopes), also distribution-free. Deterministic, no model.
 *
 * Assumes the rows are in TIME order (a log is). Significance comes from the
 * normal approximation of the S statistic, graded by the usual z critical values.
 */

type TrendDirection = "increasing" | "decreasing" | "none";
type TrendSignificance = "strong" | "significant" | "not-significant" | "insufficient";

// Below this many points the normal approximation is unreliable.
export const MIN_TREND_SAMPLE = 8;
const Z_P05 = 1.96;
const Z_P01 = 2.576;

export interface TrendResult {
  readonly n: number;
  /** Mann-Kendall S: (concordant − discordant) pairs. */
  readonly s: number;
  /** Standardized z statistic (continuity-corrected). */
  readonly z: number;
  /** Sen's slope — median per-step change (distribution-free); undefined when n < 2. */
  readonly sensSlope?: number;
  readonly direction: TrendDirection;
  readonly significance: TrendSignificance;
}

const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Median of a numeric array (sorted copy); undefined when empty. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Sen's slope: the median of (x_j − x_i)/(j − i) over all i < j. */
export function sensSlope(values: readonly number[]): number | undefined {
  const slopes: number[] = [];
  for (let i = 0; i < values.length - 1; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      slopes.push((values[j]! - values[i]!) / (j - i));
    }
  }
  return median(slopes);
}

/**
 * Mann-Kendall trend test over a time-ordered series. S sums the sign of every
 * later-minus-earlier pair; its variance (with a tie correction) gives a z score
 * whose magnitude is graded against the normal critical values.
 */
export function mannKendall(values: readonly number[]): TrendResult {
  const n = values.length;
  if (n < MIN_TREND_SAMPLE) {
    return { direction: "none", n, s: 0, sensSlope: sensSlope(values), significance: "insufficient", z: 0 };
  }
  let s = 0;
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = i + 1; j < n; j += 1) s += sign(values[j]! - values[i]!);
  }
  // Variance with a correction for tied groups.
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of counts.values()) if (t > 1) tieTerm += t * (t - 1) * (2 * t + 5);
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  const z = variance <= 0 ? 0 : s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;

  const absZ = Math.abs(z);
  const significance: TrendSignificance = absZ >= Z_P01 ? "strong" : absZ >= Z_P05 ? "significant" : "not-significant";
  const significant = significance === "strong" || significance === "significant";
  const direction: TrendDirection = significant ? (s > 0 ? "increasing" : "decreasing") : "none";
  return { direction, n, s, sensSlope: sensSlope(values), significance, z };
}

/** Render the human-readable trend report for a column. */
export function formatTrend(result: TrendResult, column: string): string {
  const lines = [`📈 Trend — column '${column}' (${result.n.toString()} points, Mann-Kendall)`];
  if (result.significance === "insufficient") {
    lines.push(`  ⚠ Only ${result.n.toString()} points — below ${MIN_TREND_SAMPLE.toString()}, a trend test is unreliable; collect more before reading into it.`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`  z = ${result.z.toFixed(2)}  (|z| >= ${Z_P05.toString()} is p<0.05)`);
  if (result.sensSlope !== undefined) lines.push(`  Sen's slope: ${result.sensSlope.toFixed(4)} per step`);
  if (result.direction === "none") {
    lines.push("  ✓ No significant trend — the values are wandering, not consistently rising or falling.");
  } else {
    const strength = result.significance === "strong" ? "Strongly " : "";
    const arrow = result.direction === "increasing" ? "rising ↗" : "falling ↘";
    lines.push(`  ⚠ ${strength}${result.direction.toUpperCase()} — the column is consistently ${arrow} (${result.significance === "strong" ? "p<0.01" : "p<0.05"}).`);
  }
  return `${lines.join("\n")}\n`;
}
