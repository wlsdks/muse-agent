import type { AgentMessage } from "./agent-message-bus.js";
import type { OrchestrationMode } from "./index.js";

/**
 * Records a single `MultiAgentOrchestrator.run()` call so operators can
 * inspect recent orchestration outcomes (mode, worker counts, success/
 * failure split, wall-clock duration) without scraping logs.
 *
 * The orchestrator records `started` first, then exactly one of
 * `completed` or `failed` once the run resolves. Stores must accept the
 * out-of-order case where a `started` is followed by a `failed` (no
 * results) and surface the entry exactly once via `list()`.
 */

export interface OrchestrationHistoryEntry {
  readonly runId: string;
  readonly mode: OrchestrationMode;
  readonly workerCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly status: "completed" | "failed";
  readonly error?: string;
  readonly conversation?: readonly AgentMessage[];
  /** Cross-worker contradiction captions the fan-in detected (coordination outcome, persisted for trend/audit). */
  readonly conflicts?: readonly string[];
  /** The objective-coverage verifier verdict, when a verifier ran (false = the answer was flagged incomplete). */
  readonly verificationSatisfied?: boolean;
}

export interface OrchestrationHistorySummary {
  readonly totalRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly lastRunAt: string | null;
  readonly byMode: {
    readonly sequential: { readonly runs: number; readonly avgDurationMs: number };
    readonly parallel: { readonly runs: number; readonly avgDurationMs: number };
    readonly race: { readonly runs: number; readonly avgDurationMs: number };
  };
}

export interface OrchestrationHistoryStore {
  record(entry: OrchestrationHistoryEntry): void;
  list(limit?: number): readonly OrchestrationHistoryEntry[];
  getByRunId(runId: string): OrchestrationHistoryEntry | undefined;
  summary(): OrchestrationHistorySummary;
  clear(): void;
}

export interface InMemoryOrchestrationHistoryStoreOptions {
  /**
   * Maximum number of entries to retain. Older entries are evicted FIFO
   * when the cap is reached. Defaults to 100.
   */
  readonly maxEntries?: number;
}

/**
 * Bounded in-memory ring buffer. Newest entry is index 0 of `list()`.
 */
export class InMemoryOrchestrationHistoryStore implements OrchestrationHistoryStore {
  private readonly entries: OrchestrationHistoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(options: InMemoryOrchestrationHistoryStoreOptions = {}) {
    const limit = options.maxEntries ?? 100;

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }

    this.maxEntries = limit;
  }

  record(entry: OrchestrationHistoryEntry): void {
    this.entries.unshift(entry);

    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
  }

  list(limit?: number): readonly OrchestrationHistoryEntry[] {
    if (limit === undefined) {
      return [...this.entries];
    }

    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError("limit must be a non-negative integer");
    }

    return this.entries.slice(0, limit);
  }

  getByRunId(runId: string): OrchestrationHistoryEntry | undefined {
    return this.entries.find((entry) => entry.runId === runId);
  }

  summary(): OrchestrationHistorySummary {
    if (this.entries.length === 0) {
      return {
        avgDurationMs: 0,
        byMode: {
          parallel: { avgDurationMs: 0, runs: 0 },
          race: { avgDurationMs: 0, runs: 0 },
          sequential: { avgDurationMs: 0, runs: 0 }
        },
        completedRuns: 0,
        failedRuns: 0,
        lastRunAt: null,
        maxDurationMs: 0,
        minDurationMs: 0,
        p95DurationMs: 0,
        totalRuns: 0
      };
    }

    const completed = this.entries.filter((entry) => entry.status === "completed").length;
    const byModeAvg = (mode: OrchestrationMode): { readonly runs: number; readonly avgDurationMs: number } => {
      const modeEntries = this.entries.filter((entry) => entry.mode === mode);
      const finite = modeEntries.map((entry) => entry.durationMs).filter((ms): ms is number => Number.isFinite(ms));
      return {
        avgDurationMs: finite.length === 0 ? 0 : Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
        runs: modeEntries.length
      };
    };
    const finiteDurations = this.entries
      .map((entry) => entry.durationMs)
      .filter((ms): ms is number => Number.isFinite(ms));
    const sortedDurations = [...finiteDurations].sort((a, b) => a - b);
    const p95Index = Math.min(sortedDurations.length - 1, Math.ceil(0.95 * sortedDurations.length) - 1);
    const totalDuration = sortedDurations.reduce((sum, value) => sum + value, 0);
    const lastRunAt = this.entries
      .map((entry) => entry.finishedAt.getTime())
      .reduce((max, current) => (current > max ? current : max), 0);

    return {
      avgDurationMs: sortedDurations.length === 0 ? 0 : Math.round(totalDuration / sortedDurations.length),
      byMode: {
        parallel: byModeAvg("parallel"),
        race: byModeAvg("race"),
        sequential: byModeAvg("sequential")
      },
      completedRuns: completed,
      failedRuns: this.entries.length - completed,
      lastRunAt: new Date(lastRunAt).toISOString(),
      maxDurationMs: sortedDurations[sortedDurations.length - 1] ?? 0,
      minDurationMs: sortedDurations[0] ?? 0,
      p95DurationMs: sortedDurations[p95Index] ?? 0,
      totalRuns: this.entries.length
    };
  }

  clear(): void {
    this.entries.length = 0;
  }
}
