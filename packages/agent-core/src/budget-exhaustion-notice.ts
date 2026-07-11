/**
 * Tool-budget exhaustion notice.
 *
 * When the loop hits `maxToolCalls`, `activeTools` is forced empty and the
 * model gets one more turn with NO tools — but until now it was never TOLD
 * why: it could produce a truncated answer as if it simply finished, or keep
 * describing tool calls it can no longer make. This is a deterministic,
 * one-shot notice naming the exact N/M so the model gives its best answer
 * with what it already gathered instead of silently truncating.
 */
export function budgetExhaustionNotice(used: number, limit: number): string {
  return (
    `You have used all ${used.toString()} of your ${limit.toString()} tool calls for this task. ` +
    "Give your best final answer now with what you have gathered — do not request more tools."
  );
}

/**
 * One-shot tracker mirroring `ReverifyNudgeTracker`'s shape: `consumeNotice`
 * returns true AT MOST ONCE so the notice is injected exactly once per run,
 * never on a loop.
 */
export class BudgetExhaustionTracker {
  private notified = false;

  consumeNotice(): boolean {
    if (this.notified) {
      return false;
    }
    this.notified = true;
    return true;
  }
}
