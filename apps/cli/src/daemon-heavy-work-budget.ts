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

export type DaemonHeavyWorkUnit = {
  readonly id: string;
  readonly run: () => Promise<void>;
};

/** A stable round-robin cursor prevents a small cap from starving later work. */
export class DaemonHeavyWorkQueue {
  #nextIndex = 0;

  async run(
    units: readonly DaemonHeavyWorkUnit[],
    maxUnits: number,
    shouldContinue: () => boolean = () => true
  ): Promise<readonly string[]> {
    if (units.length === 0) return [];
    const count = maxUnits === 0 ? units.length : Math.min(maxUnits, units.length);
    const completed: string[] = [];
    for (let attempted = 0; attempted < count; attempted += 1) {
      if (!shouldContinue()) break;
      const index = this.#nextIndex % units.length;
      const unit = units[index]!;
      // Advance at the attempt boundary so a throwing lane cannot pin the
      // cursor and starve every later lane forever.
      this.#nextIndex = (index + 1) % units.length;
      await unit.run();
      completed.push(unit.id);
    }
    return completed;
  }
}
