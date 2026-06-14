/**
 * Median of an ALREADY-ascending-sorted numeric array (the caller sorts so this
 * stays an O(1) pick, not an O(n log n) re-sort per call). Empty ⇒ 0. Shared by
 * the robust-statistics detectors — relationship-decay cadence and the
 * activity-anomaly / change-point modified-z-score + MAD — which all sort once
 * then call this for both the median and the MAD scale.
 */
export function median(sortedAscending: readonly number[]): number {
  const n = sortedAscending.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2 : sortedAscending[mid]!;
}
