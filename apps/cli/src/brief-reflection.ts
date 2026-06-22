/**
 * Pick and render ONE grounded reflection to PUSH in the morning brief.
 * Reflections (higher-order insights Muse synthesised about the user, each
 * grounded in real episodes) were pull-only (`muse reflections`); the brief is
 * the natural place to surface one unprompted. The insight is shown VERBATIM —
 * it is already cited, and feeding it back through the model would risk
 * paraphrasing the citation away.
 */

import type { StoredReflection } from "@muse/stores";

export interface BriefReflectionOptions {
  /** Only surface an insight this fresh (days), so a stale one isn't repeated every morning forever. */
  readonly maxAgeDays?: number;
}

/**
 * The strongest RECENT insight: highest supportCount (a recurring theme is more
 * worth surfacing than a one-off), tie-broken by most recent. Skips empty,
 * future-dated, or stale insights. Returns undefined when nothing qualifies.
 */
export function selectBriefReflection(
  reflections: readonly StoredReflection[],
  nowMs: number,
  options: BriefReflectionOptions = {}
): StoredReflection | undefined {
  const maxAgeMs = Math.max(1, options.maxAgeDays ?? 14) * 86_400_000;
  const fresh = reflections.filter((reflection) => {
    if (typeof reflection.insight !== "string" || reflection.insight.trim().length === 0) return false;
    const age = nowMs - reflection.createdAtMs;
    return age >= 0 && age <= maxAgeMs;
  });
  if (fresh.length === 0) return undefined;
  return [...fresh].sort((a, b) => b.supportCount - a.supportCount || b.createdAtMs - a.createdAtMs)[0];
}

/** The proactive "looking back" line — the insight verbatim, flagging a recurring theme. */
export function formatBriefReflectionLine(reflection: StoredReflection): string {
  const recurring = reflection.supportCount > 1 ? ` (a recurring theme, seen ${reflection.supportCount.toString()}×)` : "";
  return `\n💡 Looking back — ${reflection.insight.trim()}${recurring}\n`;
}
