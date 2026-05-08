import type { MuseDatabase, TraceEventTable } from "@muse/db";
import type { ModelUsage } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import type { Insertable, Kysely } from "kysely";
import { sql } from "kysely";
import {
  CostAnomalyDetector,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  type DriftStats,
  type MonthlyBudgetSnapshot,
  type SloViolation
} from "./observability-detectors.js";
import type {
  TokenCostDailyEntry,
  TokenCostQuery,
  TokenCostTopExpensiveEntry
} from "./observability-token-cost.js";
import type { LatencyQuery, LatencySummary } from "./observability-latency.js";

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

type TraceEventInsert = Insertable<TraceEventTable>;

export interface RecordedMetricEvent {
  readonly type: "agent_run" | "guard_rejection" | "output_guard_action" | "token_usage";
  readonly payload: JsonObject;
}

export class NoOpMuseTracer implements MuseTracer {
  startSpan(): SpanHandle {
    return noOpSpanHandle;
  }
}

export class NoOpAgentMetrics implements AgentMetrics {
  recordAgentRun(): void {}
  recordGuardRejection(): void {}
  recordOutputGuardAction(): void {}
  recordTokenUsage(): void {}
}

export class InMemoryMuseTracer implements MuseTracer {
  private readonly spans: MutableRecordedSpan[] = [];
  private nextId = 0;

  startSpan(name: string, attributes: SpanAttributes = {}): SpanHandle {
    const span: MutableRecordedSpan = {
      attributes: { ...attributes },
      id: `span-${++this.nextId}`,
      name,
      startedAt: new Date()
    };

    this.spans.push(span);
    return new InMemorySpanHandle(span);
  }

  recordedSpans(): readonly RecordedSpan[] {
    return this.spans.map((span) => ({
      attributes: { ...span.attributes },
      endedAt: span.endedAt,
      error: span.error,
      id: span.id,
      name: span.name,
      startedAt: span.startedAt
    }));
  }
}

export class KyselyTraceEventSink implements TraceEventSink {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async record(event: TraceEventInput): Promise<void> {
    await this.db.insertInto("trace_events").values(createTraceEventInsert(event)).execute();
  }
}

export class InMemoryTraceEventSink implements QueryableTraceEventSink {
  private readonly events: TraceEventInput[] = [];

  async record(event: TraceEventInput): Promise<void> {
    this.events.push(cloneTraceEvent(event));
  }

  list(): readonly TraceEventInput[] {
    return this.events.map(cloneTraceEvent);
  }

  listByRunId(runId: string): readonly TraceEventInput[] {
    return this.events
      .filter((event) => event.runId === runId)
      .map(cloneTraceEvent);
  }
}

export class PersistedMuseTracer implements MuseTracer {
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly sink: TraceEventSink) {}

  startSpan(name: string, attributes: SpanAttributes = {}): SpanHandle {
    const span: MutableRecordedSpan = {
      attributes: { ...attributes },
      id: readStringAttribute(attributes, "spanId") ?? `span-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      startedAt: new Date()
    };

    return new PersistedSpanHandle(span, this.sink, (promise) => this.pending.push(promise));
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending.splice(0));
  }
}

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
  readonly tenantId?: string;
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


function toNumberOrZero(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}


// Sliding-window detectors / trackers / evaluators live in
// packages/observability/src/observability-detectors.ts.
export {
  CostAnomalyDetector,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  type CostAnomaly,
  type CostAnomalyDetectorOptions,
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

export class InMemoryAgentMetrics implements AgentMetrics {
  private readonly events: RecordedMetricEvent[] = [];

  recordAgentRun(event: AgentRunMetric): void {
    this.events.push({
      payload: toJsonObject(event),
      type: "agent_run"
    });
  }

  recordGuardRejection(stage: string, reason: string, metadata: JsonObject = {}): void {
    this.events.push({
      payload: { metadata, reason, stage },
      type: "guard_rejection"
    });
  }

  recordOutputGuardAction(
    stage: string,
    action: OutputGuardMetricAction,
    reason: string,
    metadata: JsonObject = {}
  ): void {
    this.events.push({
      payload: { action, metadata, reason, stage },
      type: "output_guard_action"
    });
  }

  recordTokenUsage(usage: ModelUsage, metadata: JsonObject = {}): void {
    this.events.push({
      payload: { metadata, ...toJsonObject(usage) },
      type: "token_usage"
    });
  }

  recordedEvents(): readonly RecordedMetricEvent[] {
    return this.events.map((event) => ({
      payload: { ...event.payload },
      type: event.type
    }));
  }
}

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

export class PinoTraceEventLogger implements TraceEventSink {
  constructor(private readonly logger: PinoCompatibleLogger) {}

  async record(event: TraceEventInput): Promise<void> {
    this.logger.info(traceEventLogPayload(event), "muse trace event");
  }
}

export class OpenTelemetryTraceEventSink implements TraceEventSink {
  constructor(private readonly tracer: OpenTelemetryTracerLike) {}

  async record(event: TraceEventInput): Promise<void> {
    const span = this.tracer.startSpan(event.name, {
      attributes: {
        ...primitiveSpanAttributes(event.attributes),
        "run.id": event.runId,
        "span.id": event.spanId,
        "span.stage": event.stage
      },
      startTime: event.startedAt
    });

    for (const [key, value] of Object.entries(primitiveSpanAttributes(event.attributes))) {
      span.setAttribute(key, value);
    }

    span.setAttribute("run.id", event.runId);
    span.setAttribute("span.id", event.spanId);
    span.setAttribute("span.stage", event.stage);

    if (typeof event.attributes.error === "string") {
      span.recordException?.(event.attributes.error);
    }

    span.end();
  }
}

export class TimescaleTraceEventExporter implements TraceEventSink {
  constructor(private readonly writer: TimescaleTraceEventWriter) {}

  async record(event: TraceEventInput): Promise<void> {
    await this.writer.insertTraceEvent({
      attributes: event.attributes,
      durationMs: event.endedAt ? Math.max(0, event.endedAt.getTime() - event.startedAt.getTime()) : null,
      name: event.name,
      runId: event.runId,
      spanId: event.spanId,
      stage: event.stage,
      time: event.startedAt
    });
  }
}

export function createTenantSpanProcessor(sink: TraceEventSink): TraceEventSink {
  return {
    async record(event) {
      await sink.record({
        ...event,
        attributes: {
          "tenant.id": readTenantId(event.attributes),
          ...event.attributes
        }
      });
    }
  };
}

export function createNoOpMuseTracer(): MuseTracer {
  return new NoOpMuseTracer();
}

export function createNoOpAgentMetrics(): AgentMetrics {
  return new NoOpAgentMetrics();
}

/**
 * Wraps an existing AgentMetrics so that every `recordAgentRun` event also
 * feeds an `SloAlertEvaluator` (latency sample + success/failure result).
 * Other metric methods are forwarded unchanged so the wrapper is a drop-in
 * replacement for the inner metrics in the runtime.
 */
export function createSloFeedingAgentMetrics(slo: SloAlertEvaluator, inner: AgentMetrics): AgentMetrics {
  return createDerivedAgentMetrics({ inner, slo });
}

export interface DerivedAgentMetricsOptions {
  readonly inner: AgentMetrics;
  readonly slo?: SloAlertEvaluator;
  readonly drift?: PromptDriftDetector;
}

/**
 * Generalised fan-out: every method on the inner AgentMetrics still gets
 * called, AND each optional derived sink receives the slice of data it cares
 * about. `slo` consumes `recordAgentRun` (latency + result), `drift` consumes
 * `recordTokenUsage` (input + output token lengths). Cost-anomaly is fed via
 * `createCostAnomalyFeedingTokenUsageSink` because cost lives on
 * `TokenUsageRecord`, not on `AgentMetrics`.
 */
export function createDerivedAgentMetrics(options: DerivedAgentMetricsOptions): AgentMetrics {
  const { inner, slo, drift } = options;
  return {
    recordAgentRun(event) {
      slo?.recordLatency(event.durationMs);
      slo?.recordResult(event.status === "completed");
      inner.recordAgentRun(event);
    },
    recordGuardRejection(stage, reason, metadata) {
      inner.recordGuardRejection(stage, reason, metadata);
    },
    recordOutputGuardAction(stage, action, reason, metadata) {
      inner.recordOutputGuardAction(stage, action, reason, metadata);
    },
    recordTokenUsage(usage, metadata) {
      if (drift) {
        if (typeof usage.inputTokens === "number") {
          drift.recordInput(usage.inputTokens);
        }
        if (typeof usage.outputTokens === "number") {
          drift.recordOutput(usage.outputTokens);
        }
      }
      inner.recordTokenUsage(usage, metadata);
    }
  };
}

// Token-usage sinks + token-cost queries + cost-anomaly /
// budget-tracking decorators live in
// packages/observability/src/observability-token-cost.ts.
export {
  createBudgetTrackingTokenUsageSink,
  createCostAnomalyFeedingTokenUsageSink,
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

class InMemorySpanHandle implements SpanHandle {
  private closed = false;

  constructor(private readonly span: MutableRecordedSpan) {}

  setAttribute(key: string, value: string | number | boolean): void {
    if (this.closed) {
      return;
    }

    this.span.attributes = { ...this.span.attributes, [key]: value };
  }

  setError(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.span.error = error instanceof Error ? error.message : String(error);
  }

  end(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.span.endedAt = new Date();
  }
}

class PersistedSpanHandle implements SpanHandle {
  private closed = false;

  constructor(
    private readonly span: MutableRecordedSpan,
    private readonly sink: TraceEventSink,
    private readonly track: (promise: Promise<void>) => void
  ) {}

  setAttribute(key: string, value: string | number | boolean): void {
    if (!this.closed) {
      this.span.attributes = { ...this.span.attributes, [key]: value };
    }
  }

  setError(error: unknown): void {
    if (!this.closed) {
      this.span.error = error instanceof Error ? error.message : String(error);
    }
  }

  end(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.span.endedAt = new Date();
    const event = spanToTraceEvent(this.span);
    this.track(this.sink.record(event));
  }
}

const noOpSpanHandle: SpanHandle = {
  end: () => {},
  setAttribute: () => {},
  setError: () => {}
};

interface MutableRecordedSpan {
  id: string;
  name: string;
  attributes: SpanAttributes;
  startedAt: Date;
  endedAt?: Date;
  error?: string;
}

type StoredFollowupSuggestionEvent = Omit<FollowupSuggestionEvent, "occurredAt"> & {
  readonly kind: FollowupSuggestionEventKind;
  readonly occurredAt: Date;
};

function toJsonObject(value: object): JsonObject {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
  ) as JsonObject;
}

export function createTraceEventInsert(event: TraceEventInput): TraceEventInsert {
  return {
    attributes: event.attributes,
    ended_at: event.endedAt ?? null,
    name: event.name,
    parent_span_id: event.parentSpanId ?? null,
    run_id: event.runId,
    span_id: event.spanId,
    stage: event.stage,
    started_at: event.startedAt
  };
}

function spanToTraceEvent(span: MutableRecordedSpan): TraceEventInput {
  const attributes = {
    ...span.attributes,
    ...(span.error ? { error: span.error } : {})
  };

  return {
    attributes: attributes as JsonObject,
    endedAt: span.endedAt,
    name: span.name,
    parentSpanId: readStringAttribute(span.attributes, "parentSpanId"),
    runId: readStringAttribute(span.attributes, "runId") ?? readStringAttribute(span.attributes, "run.id") ?? "unknown",
    spanId: span.id,
    stage: readStringAttribute(span.attributes, "stage") ?? span.name,
    startedAt: span.startedAt
  };
}

function cloneTraceEvent(event: TraceEventInput): TraceEventInput {
  return {
    ...event,
    attributes: { ...event.attributes },
    endedAt: event.endedAt ? new Date(event.endedAt) : undefined,
    startedAt: new Date(event.startedAt)
  };
}

function traceEventLogPayload(event: TraceEventInput): JsonObject {
  return toJsonObject({
    attributes: event.attributes,
    durationMs: event.endedAt ? Math.max(0, event.endedAt.getTime() - event.startedAt.getTime()) : undefined,
    name: event.name,
    parentSpanId: event.parentSpanId,
    runId: event.runId,
    spanId: event.spanId,
    stage: event.stage
  });
}

function primitiveSpanAttributes(attributes: JsonObject): SpanAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    })
  );
}

function readStringAttribute(attributes: SpanAttributes, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readTenantId(attributes: JsonObject): string {
  const direct = attributes.tenantId ?? attributes["tenant.id"];
  return typeof direct === "string" && direct.trim().length > 0 ? direct : "tenant-unknown";
}

export interface JarvisObservabilitySnapshot {
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
  readonly cost?: {
    readonly baselineUsd: number;
  };
  readonly budgets?: readonly MonthlyBudgetSnapshot[];
  readonly followups?: FollowupStats;
}

export interface JarvisObservabilitySnapshotProviderOptions {
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly sloEvaluator?: SloAlertEvaluator;
  readonly driftDetector?: PromptDriftDetector;
  readonly costAnomalyDetector?: CostAnomalyDetector;
  readonly budgetTracker?: MonthlyBudgetTracker;
  readonly budgetTenantIds?: () => readonly string[];
  readonly followupSuggestionStore?: FollowupSuggestionStore;
  readonly windowDays?: number;
  readonly topExpensiveLimit?: number;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * Aggregates the every-iteration JARVIS observability primitives Muse ships
 * (latency, token cost, SLO, drift, cost-anomaly, monthly budget, follow-up
 * suggestions) into a single snapshot. Each component is optional — when a
 * dependency is absent the corresponding section is simply omitted, so the
 * provider is safe to use during partial-runtime tests and for the
 * `/api/admin/jarvis/snapshot` HTTP surface.
 *
 * Each component error is swallowed via the optional `logger`: a single
 * failed query never blocks the rest of the snapshot.
 */
export function createJarvisObservabilitySnapshotProvider(
  options: JarvisObservabilitySnapshotProviderOptions = {}
): { snapshot(): Promise<JarvisObservabilitySnapshot> } {
  const now = options.now ?? (() => new Date());
  const windowDays = Math.max(1, options.windowDays ?? 7);
  const topExpensiveLimit = Math.max(1, options.topExpensiveLimit ?? 10);

  return {
    snapshot: async (): Promise<JarvisObservabilitySnapshot> => {
      const generatedAt = now();
      const windowEnd = generatedAt;
      const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

      const result: {
        generatedAt: Date;
        windowStart: Date;
        windowEnd: Date;
        latency?: LatencySummary;
        tokenCost?: { daily: readonly TokenCostDailyEntry[]; topExpensive: readonly TokenCostTopExpensiveEntry[] };
        slo?: JarvisObservabilitySnapshot["slo"];
        drift?: DriftStats;
        cost?: { baselineUsd: number };
        budgets?: readonly MonthlyBudgetSnapshot[];
        followups?: FollowupStats;
      } = { generatedAt, windowEnd, windowStart };

      if (options.latencyQuery) {
        try {
          result.latency = await options.latencyQuery.summary({ from: windowStart, to: windowEnd });
        } catch (error) {
          options.logger?.("JarvisObservability: latencyQuery.summary failed", error);
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
          options.logger?.("JarvisObservability: tokenCostQuery failed", error);
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
          options.logger?.("JarvisObservability: sloEvaluator failed", error);
        }
      }

      if (options.driftDetector) {
        try {
          result.drift = options.driftDetector.stats();
        } catch (error) {
          options.logger?.("JarvisObservability: driftDetector failed", error);
        }
      }

      if (options.costAnomalyDetector) {
        try {
          result.cost = { baselineUsd: options.costAnomalyDetector.baseline() };
        } catch (error) {
          options.logger?.("JarvisObservability: costAnomalyDetector failed", error);
        }
      }

      if (options.budgetTracker && options.budgetTenantIds) {
        try {
          result.budgets = options.budgetTenantIds().map((tenantId) => options.budgetTracker!.snapshot(tenantId));
        } catch (error) {
          options.logger?.("JarvisObservability: budgetTracker failed", error);
        }
      }

      if (options.followupSuggestionStore) {
        try {
          result.followups = options.followupSuggestionStore.aggregateStats();
        } catch (error) {
          options.logger?.("JarvisObservability: followupSuggestionStore failed", error);
        }
      }

      return result;
    }
  };
}
