import { setTimeout as delay } from "node:timers/promises";

/**
 * Shared async delay primitive.
 *
 * Keeps all timer injection points behaviorally consistent and lets callers
 * provide custom backoffs in tests without touching production timing.
 */
export function sleep(ms: number): Promise<void> {
  const safeMs = Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0;
  return delay<void>(safeMs);
}
