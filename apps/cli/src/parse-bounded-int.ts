/**
 * Strict bounded-integer parser for CLI numeric flags, shared by every command
 * that takes a count/limit flag (--top, --best-of, --calendar-days, and the
 * listen/orchestrate/routine/debug/runs/maintenance/inbox limits). A
 * non-numeric or below-min value is REJECTED with a flag-named error rather
 * than silently falling back (so a unit-slip like `5m` is a loud error, not a
 * silent 5); a valid value is truncated and clamped into `[min, max]`.
 */
export function parseBoundedInt(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${flag} must be an integer in [${min.toString()}, ${max.toString()}] (got '${raw}')`);
  }
  return Math.min(max, Math.trunc(parsed));
}
