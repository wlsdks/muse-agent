/**
 * Tracing kernel extracted from packages/observability/src/index.ts.
 *
 * Owns the three `MuseTracer` implementations (no-op, in-memory,
 * persisted), the five `TraceEventSink` adapters (Kysely DB sink,
 * in-memory queryable sink, Pino log sink, OpenTelemetry exporter,
 * Timescale row exporter), the `createNoOpMuseTracer` convenience
 * factory, the `createTraceEventInsert` row builder, and the private
 * span-handle classes (`InMemorySpanHandle`, `PersistedSpanHandle`,
 * `noOpSpanHandle`) + the small attribute / payload helpers.
 *
 * Re-exported from the observability barrel for backwards compatibility.
 */

import type { MuseDatabase, TraceEventTable } from "@muse/db";
import { isRecord, type JsonObject } from "@muse/shared";
import type { Insertable, Kysely } from "kysely";
import type {
  MuseTracer,
  OpenTelemetryTracerLike,
  PinoCompatibleLogger,
  QueryableTraceEventSink,
  RecordedSpan,
  SpanAttributes,
  SpanHandle,
  TimescaleTraceEventWriter,
  TraceEventInput,
  TraceEventSink
} from "./index.js";

type TraceEventInsert = Insertable<TraceEventTable>;

interface MutableRecordedSpan {
  id: string;
  name: string;
  attributes: SpanAttributes;
  startedAt: Date;
  endedAt?: Date;
  error?: string;
}

export class NoOpMuseTracer implements MuseTracer {
  startSpan(): SpanHandle {
    return noOpSpanHandle;
  }
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
      // Without an ERROR status (OTel SpanStatusCode.ERROR = 2) the
      // backend shows the span as OK despite the exception, so
      // error dashboards / alerting / tail-sampling miss the failure.
      span.setStatus?.({ code: 2, message: event.attributes.error });
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

export function createNoOpMuseTracer(): MuseTracer {
  return new NoOpMuseTracer();
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

function toJsonObject(value: object): JsonObject {
  return Object.fromEntries(Object.entries(isRecord(value) ? value : {}).filter(([, entry]) => entry !== undefined)) as JsonObject;
}
