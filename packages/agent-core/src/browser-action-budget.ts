export interface BrowserActionBudget {
  readonly used: number;
  readonly max: number;
}

export function createBrowserActionBudget(max: number): BrowserActionBudget {
  if (!Number.isFinite(max) || !Number.isInteger(max) || max <= 0) {
    throw new Error("BrowserActionBudget max must be a positive finite integer");
  }

  return { max, used: 0 };
}

export function recordBrowserAction(budget: BrowserActionBudget): BrowserActionBudget {
  return { ...budget, used: budget.used + 1 };
}

// A hard cap of N permits exactly N actions, so used===max is ALREADY exhausted.
export function isBudgetExhausted(budget: BrowserActionBudget): boolean {
  return budget.used >= budget.max;
}

export function isBudgetNearCap(budget: BrowserActionBudget): boolean {
  return !isBudgetExhausted(budget) && budget.used >= budget.max - 1;
}

export function browserActionsLabel(budget: BrowserActionBudget): string {
  return `actions_used ${budget.used}/${budget.max}`;
}

export interface BrowserActionDecision {
  readonly allowed: boolean;
  readonly refusal?: string;
  readonly warning?: string;
  readonly label: string;
}

export function guardBrowserAction(budget: BrowserActionBudget): BrowserActionDecision {
  const label = browserActionsLabel(budget);

  if (isBudgetExhausted(budget)) {
    return {
      allowed: false,
      label,
      refusal: `Browser action budget exhausted (cap ${budget.max} actions) — no further actions allowed.`
    };
  }

  if (isBudgetNearCap(budget)) {
    return {
      allowed: true,
      label,
      warning: `Approaching browser action cap (${budget.max}) — wrap up soon.`
    };
  }

  return { allowed: true, label };
}
