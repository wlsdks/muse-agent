/**
 * Importance score for a tool's output, used by the runtime's
 * per-tool-result character cap (D5 — Context Engineering follow-up).
 *
 * Default cap (`maxToolOutputChars`) is uniform across every tool.
 * That's a problem for a personal assistant where a calendar result
 * ("you have 3 meetings today") deserves more retention than a
 * generic web-fetch dump that surfaced once. This helper returns a
 * multiplier in [0.4, 1.8] so the runtime can scale the cap by
 * relevance class.
 *
 * Heuristic is name-prefix based — mirrors `inferDomain` in
 * `@muse/agent-core/tool-filter` so domain semantics stay in sync
 * across the two layers without taking an explicit dependency. If
 * a future tool registers under a new prefix, this falls back to
 * the neutral 1.0 multiplier.
 */

const DOMAIN_WEIGHTS: Readonly<Record<string, number>> = {
  // Direct-impact personal data — preserve more aggressively.
  calendar: 1.5,
  notes: 1.4,
  tasks: 1.4,
  // Core: time / context / system — small, always relevant.
  core: 1.2,
  // Soft context — surface but don't overpreserve.
  messaging: 1.1,
  // System ops — moderate.
  system: 1.0,
  // Web fetch / arbitrary external — most likely noise.
  web: 0.6,
  fetch: 0.6
};

export function scoreToolOutputImportance(toolName: string): number {
  const lower = toolName.toLowerCase();
  for (const [prefix, weight] of Object.entries(DOMAIN_WEIGHTS)) {
    if (
      lower.startsWith(`muse.${prefix}.`) ||
      // Registry-backed multi-provider variants:
      //   `muse.tasks-multi.*`, `muse.calendar-multi.*`, `muse.notes-multi.*`
      // surface the same personal-data semantics as their single-
      // provider siblings, so they get the same elevated weight
      // (iter 39).
      lower.startsWith(`muse.${prefix}-multi.`) ||
      lower.includes(`.${prefix}.`) ||
      lower.startsWith(`${prefix}.`)
    ) {
      return weight;
    }
  }
  return 1.0;
}

/**
 * Convert an importance score to an effective `maxChars` budget.
 * Score < 1 trims aggressively; score > 1 preserves more. Bounded
 * so a runaway multiplier can't blow the working budget — caps at
 * 2x the configured base.
 */
export function applyToolOutputImportance(baseMaxChars: number, score: number): number {
  if (baseMaxChars <= 0 || !Number.isFinite(score) || score <= 0) {
    return baseMaxChars;
  }
  const bounded = Math.max(0.4, Math.min(2.0, score));
  return Math.max(64, Math.trunc(baseMaxChars * bounded));
}
