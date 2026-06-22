/**
 * Interpolated percentile over a millisecond sample set — the shared
 * implementation behind latency summaries and SLO p95 alerting (kept here so
 * the two callers can't drift apart again).
 */
export function percentileMs(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  if (percentile <= 0) {
    return Math.round(Math.min(...values));
  }
  if (percentile >= 1) {
    return Math.round(Math.max(...values));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = percentile * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return Math.round(sorted[lower] ?? 0);
  }
  const weight = rank - lower;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? 0;
  return Math.round(lowerValue + (upperValue - lowerValue) * weight);
}
