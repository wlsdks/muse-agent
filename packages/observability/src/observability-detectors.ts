/**
 * Sliding-window detectors / trackers / evaluators extracted from
 * packages/observability/src/index.ts.
 *
 * Owns four observability primitives that every JARVIS-style alarm
 * surface (cost-anomaly notifier, monthly-budget alerter, prompt-
 * drift detector, SLO alerter) builds on:
 *
 *   - `CostAnomalyDetector`: rolling-window cost monitor that fires
 *     when latest cost exceeds `baseline × thresholdMultiplier`.
 *   - `MonthlyBudgetTracker`: per-tenant monthly USD aggregator with
 *     month-rollover reset + bounded `maxTenants` eviction.
 *   - `PromptDriftDetector`: rolling-window first-half / second-half
 *     mean-shift detector for input + output lengths, with a 1%
 *     baseline-mean stddev floor when the baseline is uniform.
 *   - `SloAlertEvaluator`: rolling-window P95 latency + error-rate
 *     evaluator with per-type cooldown and minimum-sample gating.
 *
 * Re-exported from the observability barrel for backwards compatibility.
 */

export interface CostAnomaly {
  readonly currentCost: number;
  readonly baselineCost: number;
  readonly multiplier: number;
  readonly threshold: number;
  readonly message: string;
  readonly at: Date;
}

export interface CostAnomalyDetectorOptions {
  readonly windowSize?: number;
  readonly thresholdMultiplier?: number;
  readonly minSamples?: number;
  readonly now?: () => number;
}

export class CostAnomalyDetector {
  readonly #windowSize: number;
  readonly #thresholdMultiplier: number;
  readonly #minSamples: number;
  readonly #now: () => number;
  readonly #costs: number[] = [];

  constructor(options: CostAnomalyDetectorOptions = {}) {
    const windowSize = options.windowSize ?? 100;
    const thresholdMultiplier = options.thresholdMultiplier ?? 3;
    const minSamples = options.minSamples ?? 10;
    if (!Number.isFinite(windowSize) || windowSize <= 0) {
      throw new Error("CostAnomalyDetector windowSize must be positive");
    }
    if (!Number.isFinite(thresholdMultiplier) || thresholdMultiplier <= 0) {
      throw new Error("CostAnomalyDetector thresholdMultiplier must be positive");
    }
    if (!Number.isFinite(minSamples) || minSamples <= 0) {
      throw new Error("CostAnomalyDetector minSamples must be positive");
    }
    this.#windowSize = windowSize;
    this.#thresholdMultiplier = thresholdMultiplier;
    this.#minSamples = minSamples;
    this.#now = options.now ?? (() => Date.now());
  }

  recordCost(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      return;
    }
    this.#costs.push(costUsd);
    while (this.#costs.length > this.#windowSize) {
      this.#costs.shift();
    }
  }

  evaluate(): CostAnomaly | undefined {
    if (this.#costs.length < this.#minSamples) {
      return undefined;
    }
    const latest = this.#costs[this.#costs.length - 1] ?? 0;
    const baseline = meanOfNumbers(this.#costs);
    if (baseline <= 0) {
      return undefined;
    }
    const multiplier = latest / baseline;
    if (multiplier <= this.#thresholdMultiplier) {
      return undefined;
    }
    return {
      at: new Date(this.#now()),
      baselineCost: baseline,
      currentCost: latest,
      message:
        `Request cost $${latest.toFixed(6)} is ${multiplier.toFixed(1)}× the baseline ` +
        `$${baseline.toFixed(6)} (threshold ${this.#thresholdMultiplier.toFixed(1)}×)`,
      multiplier,
      threshold: this.#thresholdMultiplier
    };
  }

  baseline(): number {
    if (this.#costs.length === 0) {
      return 0;
    }
    return meanOfNumbers(this.#costs);
  }
}

export type MonthlyBudgetStatus = "ok" | "warning" | "exceeded";

export interface MonthlyBudgetSnapshot {
  readonly tenantId: string;
  readonly month: string;
  readonly totalCostUsd: number;
  readonly limitUsd: number;
  readonly status: MonthlyBudgetStatus;
}

export interface MonthlyBudgetTrackerOptions {
  readonly monthlyLimitUsd?: number;
  readonly warningPercent?: number;
  readonly maxTenants?: number;
  readonly now?: () => Date;
}

export class MonthlyBudgetTracker {
  readonly #monthlyLimitUsd: number;
  readonly #warningPercent: number;
  readonly #maxTenants: number;
  readonly #now: () => Date;
  readonly #costs = new Map<string, number>();
  #currentMonth: string;

  constructor(options: MonthlyBudgetTrackerOptions = {}) {
    const monthlyLimitUsd = options.monthlyLimitUsd ?? 0;
    const warningPercent = options.warningPercent ?? 80;
    const maxTenants = options.maxTenants ?? 10_000;
    if (!Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd < 0) {
      throw new Error("MonthlyBudgetTracker monthlyLimitUsd must be non-negative");
    }
    if (!Number.isFinite(warningPercent) || warningPercent <= 0 || warningPercent > 100) {
      throw new Error("MonthlyBudgetTracker warningPercent must be between 1 and 100");
    }
    if (!Number.isFinite(maxTenants) || maxTenants <= 0) {
      throw new Error("MonthlyBudgetTracker maxTenants must be positive");
    }
    this.#monthlyLimitUsd = monthlyLimitUsd;
    this.#warningPercent = warningPercent;
    this.#maxTenants = maxTenants;
    this.#now = options.now ?? (() => new Date());
    this.#currentMonth = formatYearMonth(this.#now());
  }

  recordCost(tenantId: string, costUsd: number): MonthlyBudgetStatus {
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      return "ok";
    }
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      return this.statusFor(tenantId, this.#costs.get(tenantId) ?? 0);
    }
    this.#resetIfNewMonth();
    const previous = this.#costs.get(tenantId) ?? 0;
    const next = previous + costUsd;
    this.#costs.delete(tenantId);
    this.#costs.set(tenantId, next);
    while (this.#costs.size > this.#maxTenants) {
      const oldest = this.#costs.keys().next().value;
      if (typeof oldest === "string") {
        this.#costs.delete(oldest);
      } else {
        break;
      }
    }
    return this.statusFor(tenantId, next);
  }

  currentCost(tenantId: string): number {
    this.#resetIfNewMonth();
    return this.#costs.get(tenantId) ?? 0;
  }

  /**
   * Returns the tenant IDs the tracker has seen at least once during the
   * current month. Useful for `JarvisObservabilitySnapshotProviderOptions.budgetTenantIds`.
   */
  tenantIds(): readonly string[] {
    this.#resetIfNewMonth();
    return [...this.#costs.keys()];
  }

  snapshot(tenantId: string): MonthlyBudgetSnapshot {
    const total = this.currentCost(tenantId);
    return {
      limitUsd: this.#monthlyLimitUsd,
      month: this.#currentMonth,
      status: this.statusFor(tenantId, total),
      tenantId,
      totalCostUsd: total
    };
  }

  statusFor(_tenantId: string, total: number): MonthlyBudgetStatus {
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
      this.#costs.clear();
    }
  }
}

export type DriftType = "input_length" | "output_length";

export interface DriftAnomaly {
  readonly type: DriftType;
  readonly currentMean: number;
  readonly baselineMean: number;
  readonly standardDeviation: number;
  readonly deviationFactor: number;
  readonly message: string;
  readonly at: Date;
}

export interface DriftStats {
  readonly inputMean: number;
  readonly inputStdDev: number;
  readonly outputMean: number;
  readonly outputStdDev: number;
  readonly sampleCount: number;
}

export interface PromptDriftDetectorOptions {
  readonly windowSize?: number;
  readonly deviationThreshold?: number;
  readonly minSamples?: number;
  readonly now?: () => number;
}

const DRIFT_MIN_STDDEV_FLOOR_RATIO = 0.01;

export class PromptDriftDetector {
  readonly #windowSize: number;
  readonly #deviationThreshold: number;
  readonly #minSamples: number;
  readonly #now: () => number;
  readonly #inputLengths: number[] = [];
  readonly #outputLengths: number[] = [];

  constructor(options: PromptDriftDetectorOptions = {}) {
    const windowSize = options.windowSize ?? 200;
    const deviationThreshold = options.deviationThreshold ?? 2;
    const minSamples = options.minSamples ?? 20;
    if (!Number.isFinite(windowSize) || windowSize <= 0) {
      throw new Error("PromptDriftDetector windowSize must be positive");
    }
    if (!Number.isFinite(deviationThreshold) || deviationThreshold <= 0) {
      throw new Error("PromptDriftDetector deviationThreshold must be positive");
    }
    if (!Number.isFinite(minSamples) || minSamples <= 0) {
      throw new Error("PromptDriftDetector minSamples must be positive");
    }
    this.#windowSize = windowSize;
    this.#deviationThreshold = deviationThreshold;
    this.#minSamples = minSamples;
    this.#now = options.now ?? (() => Date.now());
  }

  recordInput(length: number): void {
    if (!Number.isFinite(length) || length < 0) {
      return;
    }
    this.#inputLengths.push(length);
    while (this.#inputLengths.length > this.#windowSize) {
      this.#inputLengths.shift();
    }
  }

  recordOutput(length: number): void {
    if (!Number.isFinite(length) || length < 0) {
      return;
    }
    this.#outputLengths.push(length);
    while (this.#outputLengths.length > this.#windowSize) {
      this.#outputLengths.shift();
    }
  }

  evaluate(): readonly DriftAnomaly[] {
    const anomalies: DriftAnomaly[] = [];
    const inputAnomaly = this.#evaluateDistribution(this.#inputLengths, "input_length");
    if (inputAnomaly) {
      anomalies.push(inputAnomaly);
    }
    const outputAnomaly = this.#evaluateDistribution(this.#outputLengths, "output_length");
    if (outputAnomaly) {
      anomalies.push(outputAnomaly);
    }
    return anomalies;
  }

  stats(): DriftStats {
    return {
      inputMean: meanOfNumbers(this.#inputLengths),
      inputStdDev: stdDevOfNumbers(this.#inputLengths),
      outputMean: meanOfNumbers(this.#outputLengths),
      outputStdDev: stdDevOfNumbers(this.#outputLengths),
      sampleCount: this.#inputLengths.length
    };
  }

  #evaluateDistribution(samples: readonly number[], type: DriftType): DriftAnomaly | undefined {
    if (samples.length < this.#minSamples) {
      return undefined;
    }
    const half = Math.floor(samples.length / 2);
    const baseline = samples.slice(0, half);
    const current = samples.slice(half);
    const baselineMean = meanOfNumbers(baseline);
    const rawStdDev = stdDevOfNumbers(baseline);
    const currentMean = meanOfNumbers(current);
    if (rawStdDev <= 0 && currentMean === baselineMean) {
      return undefined;
    }
    const effectiveStdDev = rawStdDev > 0
      ? rawStdDev
      : Math.max(baselineMean * DRIFT_MIN_STDDEV_FLOOR_RATIO, 1);
    const factor = Math.abs(currentMean - baselineMean) / effectiveStdDev;
    if (factor <= this.#deviationThreshold) {
      return undefined;
    }
    const label = type === "input_length" ? "Input" : "Output";
    return {
      at: new Date(this.#now()),
      baselineMean,
      currentMean,
      deviationFactor: factor,
      message:
        `${label} length drift detected: current mean ${currentMean.toFixed(1)}, ` +
        `baseline mean ${baselineMean.toFixed(1)}, ` +
        `deviation ${factor.toFixed(1)}σ (threshold ${this.#deviationThreshold.toFixed(1)}σ)`,
      standardDeviation: effectiveStdDev,
      type
    };
  }
}

export type SloViolationType = "latency" | "error_rate";

export interface SloViolation {
  readonly type: SloViolationType;
  readonly currentValue: number;
  readonly threshold: number;
  readonly message: string;
  readonly at: Date;
}

export interface SloAlertEvaluatorOptions {
  readonly latencyThresholdMs: number;
  readonly errorRateThreshold: number;
  readonly windowSeconds: number;
  readonly cooldownSeconds: number;
  readonly minSamples?: number;
  readonly now?: () => number;
}

export class SloAlertEvaluator {
  readonly #latencyThresholdMs: number;
  readonly #errorRateThreshold: number;
  readonly #windowMs: number;
  readonly #cooldownMs: number;
  readonly #minSamples: number;
  readonly #now: () => number;
  readonly #latencies: { at: number; durationMs: number }[] = [];
  readonly #results: { at: number; success: boolean }[] = [];
  #lastLatencyAlertAt = 0;
  #lastErrorRateAlertAt = 0;

  constructor(options: SloAlertEvaluatorOptions) {
    if (!Number.isFinite(options.latencyThresholdMs) || options.latencyThresholdMs < 0) {
      throw new Error("SloAlertEvaluator latencyThresholdMs must be non-negative");
    }
    if (!Number.isFinite(options.errorRateThreshold) || options.errorRateThreshold < 0 || options.errorRateThreshold > 1) {
      throw new Error("SloAlertEvaluator errorRateThreshold must be between 0 and 1");
    }
    if (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0) {
      throw new Error("SloAlertEvaluator windowSeconds must be positive");
    }
    if (!Number.isFinite(options.cooldownSeconds) || options.cooldownSeconds < 0) {
      throw new Error("SloAlertEvaluator cooldownSeconds must be non-negative");
    }
    this.#latencyThresholdMs = options.latencyThresholdMs;
    this.#errorRateThreshold = options.errorRateThreshold;
    this.#windowMs = options.windowSeconds * 1000;
    this.#cooldownMs = options.cooldownSeconds * 1000;
    this.#minSamples = Math.max(1, options.minSamples ?? 5);
    this.#now = options.now ?? (() => Date.now());
  }

  recordLatency(durationMs: number): void {
    if (!Number.isFinite(durationMs)) {
      return;
    }
    this.#latencies.push({ at: this.#now(), durationMs: Math.max(0, durationMs) });
    this.#evictExpired();
  }

  recordResult(success: boolean): void {
    this.#results.push({ at: this.#now(), success });
    this.#evictExpired();
  }

  evaluate(): readonly SloViolation[] {
    this.#evictExpired();
    const now = this.#now();
    const violations: SloViolation[] = [];
    const latency = this.#evaluateLatency(now);
    if (latency) {
      violations.push(latency);
    }
    const errorRate = this.#evaluateErrorRate(now);
    if (errorRate) {
      violations.push(errorRate);
    }
    return violations;
  }

  snapshot(): {
    readonly latencySamples: number;
    readonly resultSamples: number;
    readonly latencyP95Ms: number | null;
    readonly errorRate: number | null;
  } {
    this.#evictExpired();
    const latencyP95 = this.#latencies.length > 0 ? percentileMs(this.#latencies.map((entry) => entry.durationMs), 0.95) : null;
    const errorRate = this.#results.length > 0
      ? this.#results.filter((entry) => !entry.success).length / this.#results.length
      : null;
    return {
      errorRate,
      latencyP95Ms: latencyP95,
      latencySamples: this.#latencies.length,
      resultSamples: this.#results.length
    };
  }

  #evaluateLatency(now: number): SloViolation | undefined {
    if (this.#latencies.length < this.#minSamples) {
      return undefined;
    }
    if (this.#isCoolingDown(this.#lastLatencyAlertAt, now)) {
      return undefined;
    }
    const p95 = percentileMs(this.#latencies.map((entry) => entry.durationMs), 0.95);
    if (p95 <= this.#latencyThresholdMs) {
      return undefined;
    }
    this.#lastLatencyAlertAt = now;
    return {
      at: new Date(now),
      currentValue: p95,
      message: `P95 latency ${p95}ms exceeded threshold ${this.#latencyThresholdMs}ms`,
      threshold: this.#latencyThresholdMs,
      type: "latency"
    };
  }

  #evaluateErrorRate(now: number): SloViolation | undefined {
    if (this.#results.length < this.#minSamples) {
      return undefined;
    }
    if (this.#isCoolingDown(this.#lastErrorRateAlertAt, now)) {
      return undefined;
    }
    const errors = this.#results.filter((entry) => !entry.success).length;
    const rate = errors / this.#results.length;
    if (rate <= this.#errorRateThreshold) {
      return undefined;
    }
    this.#lastErrorRateAlertAt = now;
    const pct = (rate * 100).toFixed(1);
    const thresholdPct = (this.#errorRateThreshold * 100).toFixed(1);
    return {
      at: new Date(now),
      currentValue: rate,
      message: `Error rate ${pct}% exceeded threshold ${thresholdPct}%`,
      threshold: this.#errorRateThreshold,
      type: "error_rate"
    };
  }

  #isCoolingDown(lastAlertAt: number, now: number): boolean {
    return lastAlertAt > 0 && now - lastAlertAt < this.#cooldownMs;
  }

  #evictExpired(): void {
    const cutoff = this.#now() - this.#windowMs;
    while (this.#latencies.length > 0 && this.#latencies[0]!.at < cutoff) {
      this.#latencies.shift();
    }
    while (this.#results.length > 0 && this.#results[0]!.at < cutoff) {
      this.#results.shift();
    }
  }
}

function meanOfNumbers(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function stdDevOfNumbers(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = meanOfNumbers(values);
  let sumSquares = 0;
  for (const value of values) {
    sumSquares += (value - mean) * (value - mean);
  }
  return Math.sqrt(sumSquares / values.length);
}

function percentileMs(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  if (percentile <= 0) {
    return Math.round(Math.min(...values));
  }
  if (percentile >= 1) {
    return Math.round(Math.max(...values));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = percentile * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return Math.round(sorted[lower] ?? 0);
  }
  const weight = rank - lower;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return Math.round(lowerValue * (1 - weight) + upperValue * weight);
}

function formatYearMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
