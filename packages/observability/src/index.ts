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

export function createNoOpMuseTracer(): MuseTracer {
  return new NoOpMuseTracer();
}

export function createNoOpAgentMetrics(): AgentMetrics {
  return new NoOpAgentMetrics();
}

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
