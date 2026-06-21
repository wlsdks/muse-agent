export function rewardDelta(direction: "up" | "down"): number {
  return direction === "up" ? 1 : -1;
}

export function canAdjustReward(reward: number, direction: "up" | "down"): boolean {
  if (direction === "up" && reward >= 5) return false;
  if (direction === "down" && reward <= -5) return false;
  return true;
}

export function summarizeSkills(entries: readonly { avoided: boolean }[]): {
  total: number;
  active: number;
  avoided: number;
} {
  let avoided = 0;
  for (const entry of entries) {
    if (entry.avoided) {
      avoided += 1;
    }
  }
  return { total: entries.length, active: entries.length - avoided, avoided };
}
