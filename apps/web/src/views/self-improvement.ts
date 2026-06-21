const AXIS_LABELS: Record<string, string> = {
  "grounding-gap": "Grounding gap",
  "source-conflict": "Conflicting notes",
  "time-parse": "Time parsing",
  "misgrounding": "Possible misgrounding",
  "wrong-tool": "Wrong tool"
};

export function weaknessAxisLabel(axis: string): string {
  return AXIS_LABELS[axis] ?? axis;
}

export function summarizeWeaknesses(entries: readonly { axis: string }[]): { total: number; axes: number } {
  const axes = new Set(entries.map((e) => e.axis)).size;
  return { total: entries.length, axes };
}

/**
 * A probation strategy is recorded but NEVER injected into agent runs until a
 * real reinforcement graduates it, so the console must not imply it is already
 * shaping behaviour — "probation" means "not yet acting", "active" means it is.
 */
export function strategyStatusLabel(entry: { probation: boolean }): "active" | "probation" {
  return entry.probation ? "probation" : "active";
}

export function summarizeStrategies(entries: readonly { probation: boolean }[]): {
  total: number;
  active: number;
  probation: number;
} {
  let probation = 0;
  for (const entry of entries) {
    if (entry.probation) {
      probation += 1;
    }
  }
  return { total: entries.length, active: entries.length - probation, probation };
}

export function summarizeReflections(entries: readonly { sourceCount: number }[]): {
  total: number;
  grounded: number;
} {
  return { total: entries.length, grounded: entries.filter((e) => e.sourceCount > 0).length };
}
