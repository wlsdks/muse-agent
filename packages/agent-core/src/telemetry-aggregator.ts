/**
 * Telemetry aggregator (phase A — real-usage data layer).
 *
 * Iter 8 stamped `ctx.<feature>_*` attrs onto every run span, and
 * iter 17 added `ctx.budget.section.*` per-section breakdown. But
 * span attrs are *per-turn* — the operator who wants to answer
 * "how often does inbox surface in the last 24h?" or "what's my
 * average prompt-budget per turn?" had to query the trace store
 * directly. No aggregation layer existed.
 *
 * This module sits in-process and consumes one `RunTelemetryEvent`
 * per agent run (stamped by `AgentRuntime` right after the run
 * completes). It maintains a rolling 7-day window of per-turn
 * snapshots and exposes summary queries:
 *
 *   - `summary({ since? })` — counters per `ctx.<feature>_*` flag,
 *     averages for `ctx.budget.*` tokens.
 *   - `recent({ limit })` — raw last-N turns.
 *
 * Stateless beyond the in-memory ring buffer. Pluggable durable
 * sink can layer on later (Kysely table); this is the read API
 * the runtime exposes today, and is enough for a `muse telemetry`
 * CLI / web panel to graph trends without touching the trace store.
 */

export interface RunTelemetryEvent {
  readonly runId: string;
  readonly model: string;
  readonly providerId: string;
  readonly recordedAtMs: number;
  readonly contextFlags: Readonly<Record<string, boolean>>;
  readonly contextCounters: Readonly<Record<string, number>>;
  readonly budgetTokens?: Readonly<Record<string, number>>;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
}

export interface TelemetrySummaryOptions {
  /** ISO timestamp lower bound. Defaults to now − 7 days. */
  readonly sinceMs?: number;
}

export interface TelemetrySummary {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly totalRuns: number;
  readonly flagCounts: Readonly<Record<string, number>>;
  readonly counterAverages: Readonly<Record<string, number>>;
  readonly budgetAverages: Readonly<Record<string, number>>;
  readonly tokenTotals: {
    readonly input: number;
    readonly output: number;
    readonly cachedInput: number;
  };
}

export interface TelemetryRecentOptions {
  /** Max events to return (most recent N). Defaults to capacity. */
  readonly limit?: number;
  /** Optional lower-bound timestamp; events older than this are excluded. */
  readonly sinceMs?: number;
}

export interface TelemetryAggregator {
  record(event: RunTelemetryEvent): void;
  summary(options?: TelemetrySummaryOptions): TelemetrySummary;
  recent(limit: number): readonly RunTelemetryEvent[];
  recent(options: TelemetryRecentOptions): readonly RunTelemetryEvent[];
  clear(): void;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_CAPACITY = 10_000;

export interface InMemoryTelemetryAggregatorOptions {
  /** Max events retained in the ring buffer. Default 10k. */
  readonly capacity?: number;
  readonly now?: () => number;
}

export class InMemoryTelemetryAggregator implements TelemetryAggregator {
  private readonly events: RunTelemetryEvent[] = [];
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: InMemoryTelemetryAggregatorOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.now = options.now ?? (() => Date.now());
  }

  record(event: RunTelemetryEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  summary(options: TelemetrySummaryOptions = {}): TelemetrySummary {
    const windowEndMs = this.now();
    const windowStartMs = options.sinceMs ?? windowEndMs - DEFAULT_WINDOW_MS;
    const inWindow = this.events.filter((event) => event.recordedAtMs >= windowStartMs && event.recordedAtMs <= windowEndMs);
    const flagCounts: Record<string, number> = {};
    const counterSums: Record<string, number> = {};
    const counterHits: Record<string, number> = {};
    const budgetSums: Record<string, number> = {};
    const budgetHits: Record<string, number> = {};
    let inputSum = 0;
    let outputSum = 0;
    let cachedSum = 0;
    for (const event of inWindow) {
      for (const [key, value] of Object.entries(event.contextFlags)) {
        if (value) {
          flagCounts[key] = (flagCounts[key] ?? 0) + 1;
        }
      }
      for (const [key, value] of Object.entries(event.contextCounters)) {
        counterSums[key] = (counterSums[key] ?? 0) + value;
        counterHits[key] = (counterHits[key] ?? 0) + 1;
      }
      for (const [key, value] of Object.entries(event.budgetTokens ?? {})) {
        budgetSums[key] = (budgetSums[key] ?? 0) + value;
        budgetHits[key] = (budgetHits[key] ?? 0) + 1;
      }
      inputSum += event.inputTokens ?? 0;
      outputSum += event.outputTokens ?? 0;
      cachedSum += event.cachedInputTokens ?? 0;
    }
    const counterAverages: Record<string, number> = {};
    for (const [key, sum] of Object.entries(counterSums)) {
      counterAverages[key] = sum / Math.max(1, counterHits[key] ?? 1);
    }
    const budgetAverages: Record<string, number> = {};
    for (const [key, sum] of Object.entries(budgetSums)) {
      budgetAverages[key] = sum / Math.max(1, budgetHits[key] ?? 1);
    }
    return {
      budgetAverages,
      counterAverages,
      flagCounts,
      tokenTotals: { cachedInput: cachedSum, input: inputSum, output: outputSum },
      totalRuns: inWindow.length,
      windowEndMs,
      windowStartMs
    };
  }

  recent(limitOrOptions: number | TelemetryRecentOptions = {}): readonly RunTelemetryEvent[] {
    const options: TelemetryRecentOptions = typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions;
    const limit = options.limit;
    const sinceMs = options.sinceMs;
    // `slice(-0)` and `slice(0)` are both "from the start" in JS,
    // so a naive `events.slice(-bound)` returned the FULL array when
    // the caller asked for 0 (or a negative / NaN limit). Guard with
    // an explicit branch so `recent(0)` is consistently empty and
    // `recent(N)` honours a finite cap.
    let filtered: readonly RunTelemetryEvent[] = this.events;
    if (typeof sinceMs === "number" && Number.isFinite(sinceMs)) {
      filtered = this.events.filter((event) => event.recordedAtMs >= sinceMs);
    }
    if (limit === undefined) {
      return filtered.slice();
    }
    const bound = Math.trunc(limit);
    if (!Number.isFinite(bound) || bound <= 0) {
      return [];
    }
    return filtered.slice(-bound);
  }

  clear(): void {
    this.events.length = 0;
  }
}
