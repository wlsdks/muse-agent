/**
 * Sliding-window detectors / trackers / evaluators extracted from
 * packages/observability/src/index.ts.
 *
 * Owns three observability primitives that every Muse alarm surface
 * (monthly-budget alerter, prompt-drift detector, SLO alerter)
 * builds on:
 *
 *   - `MonthlyBudgetTracker`: monthly USD aggregator with
 *     month-rollover reset.
 *   - `PromptDriftDetector`: rolling-window first-half / second-half
 *     mean-shift detector for input + output lengths, with a 1%
 *     baseline-mean stddev floor when the baseline is uniform.
 *   - `SloAlertEvaluator`: rolling-window P95 latency + error-rate
 *     evaluator with per-type cooldown and minimum-sample gating.
 *
 * Re-exported from the observability barrel for backwards compatibility.
 */

export {
  MonthlyBudgetTracker,
  type MonthlyBudgetSnapshot,
  type MonthlyBudgetStatus,
  type MonthlyBudgetTrackerOptions
} from "./budget-tracker.js";

export {
  PromptDriftDetector,
  type DriftAnomaly,
  type DriftStats,
  type DriftType,
  type PromptDriftDetectorOptions
} from "./observability-prompt-drift.js";

export {
  SloAlertEvaluator,
  type SloAlertEvaluatorOptions,
  type SloViolation,
  type SloViolationType
} from "./observability-slo-alert.js";

