import {
  type BrowserActionDecision,
  createBrowserActionBudget,
  guardBrowserAction,
  isBudgetExhausted,
  recordBrowserAction
} from "./browser-action-budget.js";

export interface BrowserActionTracker {
  tryConsume(): BrowserActionDecision;
  used(): number;
}

/**
 * Stateful per-task wrapper over the pure `BrowserActionBudget` core: the
 * core stays immutable/pure, this holds the mutable counter one browser
 * session's worth of state-changing actions (click/type/fill) share.
 */
export function createBrowserActionTracker(max: number): BrowserActionTracker {
  let current = createBrowserActionBudget(max);
  return {
    tryConsume(): BrowserActionDecision {
      // Decide on the PRE-consume state: exhausted → refuse without advancing,
      // so a budget already at the cap never ticks past it.
      if (isBudgetExhausted(current)) return guardBrowserAction(current);
      current = recordBrowserAction(current);
      const post = guardBrowserAction(current);
      // The allow decision was already made pre-advance — force allowed:true
      // here regardless of the post-advance guard's own allowed field, since
      // a budget that landed exactly on the cap must not read as refused for
      // the action that was just permitted.
      return post.warning ? { allowed: true, label: post.label, warning: post.warning } : { allowed: true, label: post.label };
    },
    used(): number {
      return current.used;
    }
  };
}
