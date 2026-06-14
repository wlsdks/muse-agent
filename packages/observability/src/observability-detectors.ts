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


export {
  SloAlertEvaluator,
  type SloAlertEvaluatorOptions,
  type SloViolation,
  type SloViolationType
} from "./observability-slo-alert.js";

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

