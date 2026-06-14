/**
 * Tool-failure-streak circuit breaker — withhold a tool that keeps FAILING so a
 * cascading tool failure can't burn the whole step budget.
 *
 * AgentErrorTaxonomy (arXiv:2509.25370, Zhu et al. — "Where LLM Agents Fail and
 * How They can Learn From Failures") names system-level failures (tool crashes,
 * API mismatches) as a dominant CASCADING mode: a single root-cause tool failure
 * propagates as the agent re-calls the broken tool until it exhausts maxToolCalls,
 * ending in errors instead of a clean answer.
 *
 * This is DETERMINISTIC and COMPLEMENTARY to the no-progress stall detector
 * (arXiv:2505.17616): that catches near-identical SUCCESSFUL reads (output
 * similarity, write-reset); this catches REPEATED FAILURES by STATUS — a tool
 * that fails with a DIFFERENT error string each turn evades both the exact-arg
 * deduplicator (failures aren't memoized by content here) and the stall tracker
 * (differing error text → Jaccard below floor). Per-tool counter, success-reset;
 * set-membership/count only — no text similarity, KO/paraphrase-immune.
 */

export const TOOL_FAILURE_STREAK_LIMIT = 3;

export class ToolFailureStreakTracker {
  private readonly streaks = new Map<string, number>();

  /**
   * Record a genuinely-executed tool result by STATUS. A "completed" result
   * resets the tool's streak (it recovered); any other status (a failed
   * execution) increments it.
   */
  record(toolName: string, status: string): void {
    this.streaks.set(toolName, status === "completed" ? 0 : (this.streaks.get(toolName) ?? 0) + 1);
  }

  /** True when `toolName` has failed `limit` consecutive times without a success. */
  tripped(toolName: string, limit: number = TOOL_FAILURE_STREAK_LIMIT): boolean {
    return (this.streaks.get(toolName) ?? 0) >= limit;
  }
}
