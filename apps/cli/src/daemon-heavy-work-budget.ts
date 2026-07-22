/**
 * Cooperative work-unit budget for admitted resident-daemon background work.
 * Zero is intentionally unlimited: it preserves the historical cadence until
 * an owner opts into a cap appropriate for their machine.
 */
export const DEFAULT_DAEMON_HEAVY_WORK_UNITS_PER_TICK = 0;
export const MAX_DAEMON_HEAVY_WORK_UNITS_PER_TICK = 32;

export function resolveDaemonHeavyWorkUnitsPerTick(env: NodeJS.ProcessEnv): number {
  const raw = env.MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK?.trim();
  if (!raw) return DEFAULT_DAEMON_HEAVY_WORK_UNITS_PER_TICK;
  if (!/^(0|[1-9]\d*)$/u.test(raw)) return DEFAULT_DAEMON_HEAVY_WORK_UNITS_PER_TICK;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_DAEMON_HEAVY_WORK_UNITS_PER_TICK) {
    return DEFAULT_DAEMON_HEAVY_WORK_UNITS_PER_TICK;
  }
  return parsed;
}
