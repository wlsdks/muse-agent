/**
 * Median of an arbitrary (UNSORTED) numeric array — sorts a copy, then picks the
 * middle value (empty ⇒ 0). The cadence detectors (note-family-absence,
 * personal-episodes-store) use it to find a family's / episode-series' typical
 * inter-event gap, which a mean would smear toward the occasional long pause.
 */
export function medianGap(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
