/**
 * Monthly LLM-spend budget tracker — rolls over on a new UTC month and reports
 * ok / warning / exceeded against a configured cap. Split out of
 * observability-detectors.ts (one detector per module).
 */

export type MonthlyBudgetStatus = "ok" | "warning" | "exceeded";

export interface MonthlyBudgetSnapshot {
  readonly month: string;
  readonly totalCostUsd: number;
  readonly limitUsd: number;
  readonly status: MonthlyBudgetStatus;
  /**
   * limit - totalCostUsd, clamped to 0 (can't go
   * negative once exceeded). Only set when a positive
   * `limitUsd` is configured; omitted for unlimited budgets so
   * a consumer can't accidentally render "remaining: $-12.34".
   */
  readonly remainingUsd?: number;
  /**
   * `totalCostUsd / limitUsd * 100`, clamped to
   * [0, 100]. Same omission rule as `remainingUsd`: undefined
   * when `limitUsd <= 0` to avoid divide-by-zero artefacts.
   * Surfaced so the status dashboard renders a single
   * "27% used" without each consumer recomputing the ratio.
   */
  readonly percentUsed?: number;
}

export interface MonthlyBudgetTrackerOptions {
  readonly monthlyLimitUsd?: number;
  readonly warningPercent?: number;
  readonly now?: () => Date;
}

export class MonthlyBudgetTracker {
  readonly #monthlyLimitUsd: number;
  readonly #warningPercent: number;
  readonly #now: () => Date;
  #total = 0;
  #currentMonth: string;

  constructor(options: MonthlyBudgetTrackerOptions = {}) {
    const monthlyLimitUsd = options.monthlyLimitUsd ?? 0;
    const warningPercent = options.warningPercent ?? 80;
    if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0) {
      throw new Error("MonthlyBudgetTracker monthlyLimitUsd must be non-negative");
    }
    if (!Number.isFinite(warningPercent) || warningPercent <= 0 || warningPercent > 100) {
      throw new Error("MonthlyBudgetTracker warningPercent must be between 1 and 100");
    }
    this.#monthlyLimitUsd = monthlyLimitUsd;
    this.#warningPercent = warningPercent;
    this.#now = options.now ?? (() => new Date());
    this.#currentMonth = formatYearMonth(this.#now());
  }

  recordCost(costUsd: number): MonthlyBudgetStatus {
    // Roll the month over BEFORE the validity check: a non-finite /
    // negative cost (e.g. a provider reporting NaN — `?? 0` doesn't
    // coerce NaN) arriving first in a new month must not return the
    // previous month's (possibly "exceeded") status for a $0 month.
    this.#resetIfNewMonth();
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      return this.statusFor(this.#total);
    }
    this.#total += costUsd;
    return this.statusFor(this.#total);
  }

  currentCost(): number {
    this.#resetIfNewMonth();
    return this.#total;
  }

  snapshot(): MonthlyBudgetSnapshot {
    const total = this.currentCost();
    const hasLimit = this.#monthlyLimitUsd > 0;
    return {
      limitUsd: this.#monthlyLimitUsd,
      month: this.#currentMonth,
      status: this.statusFor(total),
      totalCostUsd: total,
      ...(hasLimit
        ? {
            percentUsed: Math.min(100, Math.max(0, (total / this.#monthlyLimitUsd) * 100)),
            remainingUsd: Math.max(0, this.#monthlyLimitUsd - total)
          }
        : {})
    };
  }

  statusFor(total: number): MonthlyBudgetStatus {
    if (this.#monthlyLimitUsd <= 0) {
      return "ok";
    }
    const ratio = total / this.#monthlyLimitUsd;
    if (ratio >= 1) {
      return "exceeded";
    }
    if (ratio >= this.#warningPercent / 100) {
      return "warning";
    }
    return "ok";
  }

  #resetIfNewMonth(): void {
    const month = formatYearMonth(this.#now());
    if (month !== this.#currentMonth) {
      this.#currentMonth = month;
      this.#total = 0;
    }
  }
}

function formatYearMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
