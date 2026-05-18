/**
 * Telemetry aggregator (phase A — real-usage data layer).
 *
 * Run spans already carry `ctx.<feature>_*` attrs and a
 * `ctx.budget.section.*` per-section breakdown, but
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
  /**
   * End-to-end run wall-clock duration in milliseconds. Computed by
   * the runtime as `recordedAtMs - startedAtMs` so the aggregator
   * can answer "how slow are my agent runs?" without re-correlating
   * across `run.started` and `run.completed` traces.
   */
  readonly latencyMs?: number;
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
  /**
   * Run-latency stats across events whose `latencyMs` was recorded.
   * Undefined when no event in the window carried a latency value
   * (older events, or future telemetry shapes that omit it).
   */
  readonly latency?: {
    readonly count: number;
    readonly averageMs: number;
    readonly maxMs: number;
    readonly p95Ms: number;
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
    const latencies: number[] = [];
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
      if (typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs) && event.latencyMs >= 0) {
        latencies.push(event.latencyMs);
      }
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
      ...(latencies.length > 0 ? { latency: computeLatencyStats(latencies) } : {}),
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

/**
 * Compute average / max / p95 over a non-empty array of latencies.
 * Sort + nearest-rank percentile; cheap because the in-memory ring
 * buffer caps at DEFAULT_CAPACITY (10k) entries.
 */
function computeLatencyStats(latencies: readonly number[]): NonNullable<TelemetrySummary["latency"]> {
  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((total, value) => total + value, 0);
  const averageMs = sum / count;
  const maxMs = sorted[count - 1] ?? 0;
  // Nearest-rank p95: `ceil(0.95 * n)`-th element (1-indexed). For
  // small samples (n < 20) p95 collapses to the max; that's the
  // honest behaviour given we don't have enough data to distinguish.
  const p95Index = Math.min(count - 1, Math.ceil(0.95 * count) - 1);
  const p95Ms = sorted[Math.max(0, p95Index)] ?? maxMs;
  return { averageMs, count, maxMs, p95Ms };
}
