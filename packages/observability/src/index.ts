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
  /** OTel `Span.setStatus` — `{ code }` uses SpanStatusCode (ERROR = 2). */
  setStatus?(status: { readonly code: number; readonly message?: string }): void;
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


// InMemoryFollowupSuggestionStore lives in
// packages/observability/src/followup-suggestion-store.ts.
export { InMemoryFollowupSuggestionStore } from "./followup-suggestion-store.js";

// StartupDoctor + createCacheStartupCheck / createMcpStartupCheck live in
// packages/observability/src/startup-doctor.ts.
export { StartupDoctor, createCacheStartupCheck, createMcpStartupCheck } from "./startup-doctor.js";

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

export {
  aggregateTokenUsage,
  JsonlTokenUsageSink,
  readLocalTokenUsage,
  type TokenUsageGroup,
  type TokenUsageSummary
} from "./observability-token-usage-local.js";


