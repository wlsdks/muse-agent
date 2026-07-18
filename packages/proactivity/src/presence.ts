export const DEFAULT_ACTIVE_SESSION_WINDOW_MS = 5 * 60_000;

/**
 * Returns whether an activity timestamp is recent enough to represent a live
 * user session. Invalid clocks, timestamps, and explicit windows fail closed.
 */
export function isRecentProactiveActivity(
  lastActivityMs: number | undefined,
  nowMs: number,
  windowMs?: number
): boolean {
  const resolvedWindowMs = windowMs ?? DEFAULT_ACTIVE_SESSION_WINDOW_MS;
  if (!Number.isFinite(nowMs) || nowMs < 0) return false;
  if (!Number.isFinite(resolvedWindowMs) || resolvedWindowMs < 0) return false;
  if (lastActivityMs === undefined || !Number.isFinite(lastActivityMs) || lastActivityMs < 0) return false;
  if (lastActivityMs > nowMs) return false;
  return nowMs - lastActivityMs <= resolvedWindowMs;
}
