import type { ModelUsage } from "@muse/model";
import type { JsonObject } from "@muse/shared";

export type SpanAttributes = Readonly<Record<string, string | number | boolean>>;
export type OutputGuardMetricAction = "allowed" | "modified" | "rejected";
export type AgentRunMetricStatus = "completed" | "failed";
export type FollowupSuggestionEventKind = "impression" | "click";

export interface MuseTracer {
  startSpan(name: string, attributes?: SpanAttributes): SpanHandle;
}

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  setError(error: unknown): void;
  end(): void;
}

export interface AgentMetrics {
  recordAgentRun(event: AgentRunMetric): void;
  recordGuardRejection(stage: string, reason: string, metadata?: JsonObject): void;
  recordOutputGuardAction(
    stage: string,
    action: OutputGuardMetricAction,
    reason: string,
    metadata?: JsonObject
  ): void;
  recordTokenUsage(usage: ModelUsage, metadata?: JsonObject): void;
}

export interface TraceEventInput {
  readonly runId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly stage: string;
  readonly attributes: JsonObject;
  readonly startedAt: Date;
  readonly endedAt?: Date;
}

export interface TraceEventSink {
  record(event: TraceEventInput): Promise<void>;
}

export interface QueryableTraceEventSink extends TraceEventSink {
  list(): readonly TraceEventInput[];
  listByRunId(runId: string): readonly TraceEventInput[];
}

export interface FollowupSuggestionEvent {
  readonly suggestionId: string;
  readonly category: string;
  readonly channelId: string;
  readonly userId: string;
  readonly messageTs?: string;
  readonly occurredAt?: Date;
}

export interface FollowupCategoryStats {
  readonly category: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
}

export interface FollowupStats {
  readonly totalImpressions: number;
  readonly totalClicks: number;
  readonly ctr: number;
  readonly byCategory: readonly FollowupCategoryStats[];
}

export interface FollowupSuggestionStore {
  recordImpression(event: FollowupSuggestionEvent): void;
  recordClick(event: FollowupSuggestionEvent): void;
  aggregateStats(windowMs?: number): FollowupStats;
}

export interface StartupCheck {
  readonly id: string;
  readonly required?: boolean;
  run(): Promise<StartupCheckResult> | StartupCheckResult;
}

export interface StartupCheckResult {
  readonly details?: JsonObject;
  readonly ok: boolean;
}

export interface CacheHealthProbe {
  get(key: string): Promise<unknown> | unknown;
  put?(key: string, value: unknown): Promise<unknown> | unknown;
}

export interface McpHealthProbe {
  listServers(): Promise<readonly { readonly name: string; readonly healthy?: boolean; readonly status?: string }[]> |
    readonly { readonly name: string; readonly healthy?: boolean; readonly status?: string }[];
}

export interface StartupDoctorCheckReport {
  readonly details?: JsonObject;
  readonly id: string;
  readonly ok: boolean;
  readonly required: boolean;
}

export interface StartupDoctorReport {
  readonly checks: readonly StartupDoctorCheckReport[];
  readonly ok: boolean;
}

export interface PinoCompatibleLogger {
  info(payload: JsonObject, message?: string): void;
}

export interface OpenTelemetrySpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException?(error: unknown): void;
  end(): void;
}

export interface OpenTelemetryTracerLike {
  startSpan(name: string, options?: { readonly attributes?: SpanAttributes; readonly startTime?: Date }): OpenTelemetrySpanLike;
}

export interface TimescaleTraceEventRow {
  readonly time: Date;
  readonly runId: string;
  readonly spanId: string;
  readonly name: string;
  readonly stage: string;
  readonly durationMs: number | null;
  readonly attributes: JsonObject;
}

export interface TimescaleTraceEventWriter {
  insertTraceEvent(row: TimescaleTraceEventRow): Promise<void>;
}

export interface InMemoryFollowupSuggestionStoreOptions {
  readonly maxEvents?: number;
  readonly retentionMs?: number;
  readonly now?: () => Date;
}

export interface AgentRunMetric {
  readonly runId: string;
  readonly model: string;
  readonly status: AgentRunMetricStatus;
  readonly durationMs: number;
  readonly metadata?: JsonObject;
}

export interface RecordedSpan {
  readonly id: string;
  readonly name: string;
  readonly attributes: SpanAttributes;
  readonly startedAt: Date;
  readonly endedAt?: Date;
  readonly error?: string;
}

export interface RecordedMetricEvent {
  readonly type: "agent_run" | "guard_rejection" | "output_guard_action" | "token_usage";
  readonly payload: JsonObject;
}

// AgentMetrics implementations + the SLO/drift fan-out decorators
// live in packages/observability/src/observability-agent-metrics.ts.
export {
  createDerivedAgentMetrics,
  createNoOpAgentMetrics,
  createSloFeedingAgentMetrics,
  InMemoryAgentMetrics,
  NoOpAgentMetrics,
  type DerivedAgentMetricsOptions
} from "./observability-agent-metrics.js";

// Muse observability snapshot provider lives in
// packages/observability/src/observability-muse-snapshot.ts.
export {
  createMuseObservabilitySnapshotProvider,
  type MuseObservabilitySnapshot,
  type MuseObservabilitySnapshotProviderOptions
} from "./observability-muse-snapshot.js";

// Tracing kernel (NoOp / InMemory / Persisted MuseTracer + the five
// TraceEventSink adapters + createNoOpMuseTracer +
// createTraceEventInsert) lives in
// packages/observability/src/observability-tracers.ts.
export {
  createNoOpMuseTracer,
  createTraceEventInsert,
  InMemoryMuseTracer,
  InMemoryTraceEventSink,
  KyselyTraceEventSink,
  NoOpMuseTracer,
  OpenTelemetryTraceEventSink,
  PersistedMuseTracer,
  PinoTraceEventLogger,
  TimescaleTraceEventExporter
} from "./observability-tracers.js";

type StoredFollowupSuggestionEvent = Omit<FollowupSuggestionEvent, "occurredAt"> & {
  readonly kind: FollowupSuggestionEventKind;
  readonly occurredAt: Date;
};

// Latency-query primitives (in-memory + Kysely, types, defaults) live in
// packages/observability/src/observability-latency.ts.
export {
  InMemoryLatencyQuery,
  KyselyLatencyQuery,
  LATENCY_DEFAULT_BUCKET_SIZE_MS,
  LATENCY_DEFAULT_SPAN_NAME_PREFIX,
  type LatencyPoint,
  type LatencyQuery,
  type LatencySummary,
  type LatencySummaryInput,
  type LatencyTimeSeriesInput
} from "./observability-latency.js";

export interface TokenUsageRecord {
  readonly runId: string;
  readonly model: string;
  readonly provider: string;
  readonly stepType?: string;
  readonly promptTokens: number;
  readonly promptCachedTokens?: number;
  readonly completionTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number;
  readonly recordedAt?: Date;
}

export interface TokenUsageSink {
  record(event: TokenUsageRecord): Promise<void>;
}

export interface QueryableTokenUsageSink extends TokenUsageSink {
  list(): readonly TokenUsageRecord[];
}




// Sliding-window detectors / trackers / evaluators live in
// packages/observability/src/observability-detectors.ts.
export {
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  type DriftAnomaly,
  type DriftStats,
  type DriftType,
  type MonthlyBudgetSnapshot,
  type MonthlyBudgetStatus,
  type MonthlyBudgetTrackerOptions,
  type PromptDriftDetectorOptions,
  type SloAlertEvaluatorOptions,
  type SloViolation,
  type SloViolationType
} from "./observability-detectors.js";


export class InMemoryFollowupSuggestionStore implements FollowupSuggestionStore {
  static readonly defaultMaxEvents = 50_000;
  static readonly defaultRetentionMs = 72 * 60 * 60 * 1000;

  private readonly events: StoredFollowupSuggestionEvent[] = [];
  private readonly maxEvents: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;

  constructor(options: InMemoryFollowupSuggestionStoreOptions = {}) {
    this.maxEvents = Math.max(1, options.maxEvents ?? InMemoryFollowupSuggestionStore.defaultMaxEvents);
    this.retentionMs = Math.max(1, options.retentionMs ?? InMemoryFollowupSuggestionStore.defaultRetentionMs);
    this.now = options.now ?? (() => new Date());
  }

  recordImpression(event: FollowupSuggestionEvent): void {
    this.record("impression", event);
  }

  recordClick(event: FollowupSuggestionEvent): void {
    this.record("click", event);
  }

  aggregateStats(windowMs = 24 * 60 * 60 * 1000): FollowupStats {
    this.purgeExpired();
    const since = this.now().getTime() - Math.max(1, windowMs);
    const events = this.events.filter((event) => event.occurredAt.getTime() >= since);
    const impressions = events.filter((event) => event.kind === "impression");
    const clicks = events.filter((event) => event.kind === "click");
    const categories = new Set(events.map((event) => event.category));
    const byCategory = [...categories]
      .map((category) => {
        const categoryImpressions = impressions.filter((event) => event.category === category).length;
        const categoryClicks = clicks.filter((event) => event.category === category).length;
        return {
          category,
          clicks: categoryClicks,
          ctr: categoryImpressions > 0 ? categoryClicks / categoryImpressions : 0,
          impressions: categoryImpressions
        };
      })
      .sort((left, right) => right.clicks - left.clicks || left.category.localeCompare(right.category));

    return {
      byCategory,
      ctr: impressions.length > 0 ? clicks.length / impressions.length : 0,
      totalClicks: clicks.length,
      totalImpressions: impressions.length
    };
  }

  private record(kind: FollowupSuggestionEventKind, event: FollowupSuggestionEvent): void {
    this.events.push({
      ...event,
      kind,
      occurredAt: event.occurredAt ?? this.now()
    });
    this.purgeExpired();
    this.trimOldest();
  }

  private purgeExpired(): void {
    const cutoff = this.now().getTime() - this.retentionMs;

    while (this.events[0] && this.events[0].occurredAt.getTime() < cutoff) {
      this.events.shift();
    }
  }

  private trimOldest(): void {
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }
}

export class StartupDoctor {
  constructor(private readonly checks: readonly StartupCheck[]) {}

  async run(): Promise<StartupDoctorReport> {
    const reports: StartupDoctorCheckReport[] = [];

    for (const check of this.checks) {
      const required = check.required !== false;

      try {
        const result = await check.run();
        reports.push({
          ...(result.details ? { details: result.details } : {}),
          id: check.id,
          ok: result.ok,
          required
        });
      } catch (error) {
        reports.push({
          details: {
            message: error instanceof Error ? error.message : String(error)
          },
          id: check.id,
          ok: false,
          required
        });
      }
    }

    return {
      checks: reports,
      ok: reports.every((report) => report.ok || !report.required)
    };
  }
}

export function createCacheStartupCheck(
  cache: CacheHealthProbe | undefined,
  options: { readonly id?: string; readonly required?: boolean; readonly probeKey?: string } = {}
): StartupCheck {
  const id = options.id ?? "cache";

  return {
    id,
    required: options.required ?? false,
    async run(): Promise<StartupCheckResult> {
      if (!cache) {
        return { details: { configured: false }, ok: false };
      }

      const probeKey = options.probeKey ?? "__muse_startup_probe__";
      await cache.put?.(probeKey, { ok: true });
      await cache.get(probeKey);
      return { details: { configured: true, probeKey }, ok: true };
    }
  };
}

export function createMcpStartupCheck(
  probe: McpHealthProbe | undefined,
  options: { readonly id?: string; readonly required?: boolean } = {}
): StartupCheck {
  const id = options.id ?? "mcp";

  return {
    id,
    required: options.required ?? false,
    async run(): Promise<StartupCheckResult> {
      if (!probe) {
        return { details: { configured: false }, ok: false };
      }

      const servers = await probe.listServers();
      const unhealthy = servers.filter((server) => server.healthy === false || server.status === "unhealthy");
      return {
        details: {
          serverCount: servers.length,
          unhealthy: unhealthy.map((server) => server.name)
        },
        ok: unhealthy.length === 0
      };
    }
  };
}



// Token-usage sinks + token-cost queries + cost-anomaly /
// budget-tracking decorators live in
// packages/observability/src/observability-token-cost.ts.
export {
  createBudgetTrackingTokenUsageSink,
  InMemoryTokenCostQuery,
  InMemoryTokenUsageSink,
  KyselyTokenCostQuery,
  KyselyTokenUsageSink,
  type TokenCostBySessionEntry,
  type TokenCostDailyEntry,
  type TokenCostQuery,
  type TokenCostQueryWindow,
  type TokenCostTopExpensiveEntry
} from "./observability-token-cost.js";


