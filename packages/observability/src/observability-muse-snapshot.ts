/**
 * Muse observability snapshot provider extracted from
 * packages/observability/src/index.ts.
 *
 * Aggregates the full set of every-iteration Muse observability
 * primitives (latency, token cost, SLO, drift, cost-anomaly,
 * monthly budget, follow-up suggestions) into a single snapshot.
 * Each component is optional — when a dependency is absent the
 * corresponding section is simply omitted, so the provider is safe
 * during partial-runtime tests and for the
 * `/api/admin/muse/snapshot` HTTP surface.
 *
 * Each component's failure is swallowed via the optional `logger`
 * so a single failed query never blocks the rest of the snapshot.
 *
 * Re-exported from the observability barrel for backwards compatibility.
 */

import type {
  DriftStats,
  MonthlyBudgetSnapshot,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  SloViolation
} from "./observability-detectors.js";
import type {
  LatencyQuery,
  LatencySummary
} from "./observability-latency.js";
import type {
  TokenCostDailyEntry,
  TokenCostQuery,
  TokenCostTopExpensiveEntry
} from "./observability-token-cost.js";
import type { FollowupStats, FollowupSuggestionStore } from "./index.js";

export interface MuseObservabilitySnapshot {
  readonly generatedAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly latency?: LatencySummary;
  readonly tokenCost?: {
    readonly daily: readonly TokenCostDailyEntry[];
    readonly topExpensive: readonly TokenCostTopExpensiveEntry[];
  };
  readonly slo?: {
    readonly latencyP95Ms: number | null;
    readonly errorRate: number | null;
    readonly latencySamples: number;
    readonly resultSamples: number;
    readonly violations: readonly SloViolation[];
  };
  readonly drift?: DriftStats;
  readonly budget?: MonthlyBudgetSnapshot;
  readonly followups?: FollowupStats;
}

export interface MuseObservabilitySnapshotProviderOptions {
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly sloEvaluator?: SloAlertEvaluator;
  readonly driftDetector?: PromptDriftDetector;
  readonly budgetTracker?: MonthlyBudgetTracker;
  readonly followupSuggestionStore?: FollowupSuggestionStore;
  readonly windowDays?: number;
  readonly topExpensiveLimit?: number;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createMuseObservabilitySnapshotProvider(
  options: MuseObservabilitySnapshotProviderOptions = {}
): { snapshot(): Promise<MuseObservabilitySnapshot> } {
  const now = options.now ?? (() => new Date());
  const windowDays = Math.max(1, options.windowDays ?? 7);
  const topExpensiveLimit = Math.max(1, options.topExpensiveLimit ?? 10);

  return {
    snapshot: async (): Promise<MuseObservabilitySnapshot> => {
      const generatedAt = now();
      const windowEnd = generatedAt;
      const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

      const result: {
        generatedAt: Date;
        windowStart: Date;
        windowEnd: Date;
        latency?: LatencySummary;
        tokenCost?: { daily: readonly TokenCostDailyEntry[]; topExpensive: readonly TokenCostTopExpensiveEntry[] };
        slo?: MuseObservabilitySnapshot["slo"];
        drift?: DriftStats;
        budget?: MonthlyBudgetSnapshot;
        followups?: FollowupStats;
      } = { generatedAt, windowEnd, windowStart };

      if (options.latencyQuery) {
        try {
          result.latency = await options.latencyQuery.summary({ from: windowStart, to: windowEnd });
        } catch (error) {
          options.logger?.("MuseObservability: latencyQuery.summary failed", error);
        }
      }

      if (options.tokenCostQuery) {
        try {
          const [daily, topExpensive] = await Promise.all([
            options.tokenCostQuery.daily({ from: windowStart, to: windowEnd }),
            options.tokenCostQuery.topExpensive({ from: windowStart, limit: topExpensiveLimit, to: windowEnd })
          ]);
          result.tokenCost = { daily, topExpensive };
        } catch (error) {
          options.logger?.("MuseObservability: tokenCostQuery failed", error);
        }
      }

      if (options.sloEvaluator) {
        try {
          const sloSnapshot = options.sloEvaluator.snapshot();
          result.slo = {
            errorRate: sloSnapshot.errorRate,
            latencyP95Ms: sloSnapshot.latencyP95Ms,
            latencySamples: sloSnapshot.latencySamples,
            resultSamples: sloSnapshot.resultSamples,
            violations: options.sloEvaluator.evaluate()
          };
        } catch (error) {
          options.logger?.("MuseObservability: sloEvaluator failed", error);
        }
      }

      if (options.driftDetector) {
        try {
          result.drift = options.driftDetector.stats();
        } catch (error) {
          options.logger?.("MuseObservability: driftDetector failed", error);
        }
      }

      if (options.budgetTracker) {
        try {
          result.budget = options.budgetTracker.snapshot();
        } catch (error) {
          options.logger?.("MuseObservability: budgetTracker failed", error);
        }
      }

      if (options.followupSuggestionStore) {
        try {
          result.followups = options.followupSuggestionStore.aggregateStats();
        } catch (error) {
          options.logger?.("MuseObservability: followupSuggestionStore failed", error);
        }
      }

      return result;
    }
  };
}
