export const SUB_AGENT_BUDGET_RATIO = 0.5;
export const SUB_AGENT_MIN_BUDGET = 3;
export const SUB_AGENT_UNCAPPED_DEFAULT = 5;

/**
 * A worker sub-agent runs a FOCUSED sub-task and must not spend the whole
 * parent budget — a fan-out of N workers would otherwise cost N× the cap.
 * Give it a smaller separate budget: half the parent (floored to a usable
 * minimum), or a fixed default when the parent is uncapped.
 *
 * A non-finite / ≤0 parent (a caller bug, not a real "uncapped" signal) is
 * treated the same as `undefined` — the uncapped default — since there is no
 * usable parent number to halve; this never returns 0/negative/NaN.
 */
export function resolveSubAgentToolBudget(parentMaxTools: number | undefined): number {
  if (parentMaxTools === undefined || !Number.isFinite(parentMaxTools) || parentMaxTools <= 0) {
    return SUB_AGENT_UNCAPPED_DEFAULT;
  }
  return Math.max(SUB_AGENT_MIN_BUDGET, Math.floor(parentMaxTools * SUB_AGENT_BUDGET_RATIO));
}
