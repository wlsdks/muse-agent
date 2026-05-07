/**
 * Step token budget tracker.
 *
 * Tracks cumulative input + output tokens across the steps of an agent run
 * and surfaces an `ok` / `soft_limit` / `exhausted` status. The soft limit
 * defaults to 80% of `maxTokens`; once cumulative usage crosses it, callers
 * can choose to wind down (e.g. switch to a direct answer) before the hard
 * exhaustion point.
 *
 * Behavior is deterministic given identical inputs: no clock, no randomness.
 */

export type BudgetStatus = "ok" | "soft_limit" | "exhausted";

export interface StepBudgetRecord {
  readonly step: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cumulativeTokens: number;
  readonly status: BudgetStatus;
}

export interface StepBudgetTrackerOptions {
  readonly maxTokens: number;
  readonly softLimitPercent?: number;
}

export class StepBudgetTracker {
  readonly #maxTokens: number;
  readonly #softLimitPercent: number;
  #consumedTokens = 0;
  readonly #history: StepBudgetRecord[] = [];

  constructor(options: StepBudgetTrackerOptions) {
    if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
      throw new Error("StepBudgetTracker maxTokens must be greater than 0");
    }

    const softLimitPercent = options.softLimitPercent ?? 80;
    if (!Number.isFinite(softLimitPercent) || softLimitPercent <= 0 || softLimitPercent >= 100) {
      throw new Error("StepBudgetTracker softLimitPercent must be between 1 and 99");
    }

    this.#maxTokens = options.maxTokens;
    this.#softLimitPercent = softLimitPercent;
  }

  trackStep(step: string, inputTokens: number, outputTokens: number): BudgetStatus {
    if (step.trim().length === 0) {
      throw new Error("StepBudgetTracker step must not be blank");
    }

    if (!isNonNegativeTokenCount(inputTokens) || !isNonNegativeTokenCount(outputTokens)) {
      throw new Error("StepBudgetTracker token counts must be non-negative finite numbers");
    }

    this.#consumedTokens += inputTokens + outputTokens;
    const status = this.status();
    this.#history.push({
      cumulativeTokens: this.#consumedTokens,
      inputTokens,
      outputTokens,
      status,
      step
    });

    return status;
  }

  recordToolOutput(step: string, toolOutputTokens: number): BudgetStatus {
    return this.trackStep(step, toolOutputTokens, 0);
  }

  status(): BudgetStatus {
    if (this.#consumedTokens >= this.#maxTokens) {
      return "exhausted";
    }

    const softLimitTokens = Math.floor((this.#maxTokens * this.#softLimitPercent) / 100);
    return this.#consumedTokens >= softLimitTokens ? "soft_limit" : "ok";
  }

  totalConsumed(): number {
    return this.#consumedTokens;
  }

  remaining(): number {
    return Math.max(0, this.#maxTokens - this.#consumedTokens);
  }

  isExhausted(): boolean {
    return this.status() === "exhausted";
  }

  history(): readonly StepBudgetRecord[] {
    return [...this.#history];
  }
}

function isNonNegativeTokenCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
