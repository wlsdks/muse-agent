/**
 * SLO alert evaluator — sliding-window latency/error-rate SLO violation
 * detection. Split out of observability-detectors.ts (one detector per module)
 * over its own p95 percentile helper.
 */

import { percentileMs } from "./observability-percentile.js";

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
    if (
      options.minSamples !== undefined
      && (!Number.isFinite(options.minSamples) || options.minSamples <= 0)
    ) {
      throw new Error("SloAlertEvaluator minSamples must be positive");
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
