/**
 * Latency-query primitives extracted from
 * packages/observability/src/index.ts.
 *
 * Owns the `LatencyQuery` interface + the in-memory and Kysely-backed
 * implementations (timeSeries: hour-bucketed avg + p95 + count;
 * summary: avg + p50/p95/p99 across an arbitrary window). The
 * Kysely implementation uses Postgres `PERCENTILE_CONT(0.95) WITHIN
 * GROUP` for true p95 / p99 instead of the in-memory sort + linear
 * interpolation. Span filtering supports either an exact `spanName`
 * or a `spanNamePrefix` (default `muse.agent.`) so the same query
 * surface drives the Muse observability snapshot, the admin
 * `/api/admin/metrics/latency/{summary,timeseries}` endpoints, and
 * any operator dashboard built on top.
 *
 * Re-exported from the observability barrel for backwards compatibility.
 */

import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { percentileMs } from "./observability-percentile.js";
import type { QueryableTraceEventSink, TraceEventInput } from "./index.js";

export const LATENCY_DEFAULT_BUCKET_SIZE_MS = 60 * 60 * 1000;
export const LATENCY_DEFAULT_SPAN_NAME_PREFIX = "muse.agent.";

export interface LatencyTimeSeriesInput {
  readonly from: Date;
  readonly to: Date;
  readonly bucketSizeMs?: number;
  readonly spanName?: string;
  readonly spanNamePrefix?: string;
}

export interface LatencyPoint {
  readonly bucketStart: Date;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly count: number;
}

export interface LatencySummaryInput {
  readonly from: Date;
  readonly to: Date;
  readonly spanName?: string;
  readonly spanNamePrefix?: string;
}

export interface LatencySummary {
  readonly count: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface LatencyQuery {
  timeSeries(input: LatencyTimeSeriesInput): Promise<readonly LatencyPoint[]>;
  summary(input: LatencySummaryInput): Promise<LatencySummary>;
}

export class InMemoryLatencyQuery implements LatencyQuery {
  constructor(private readonly sink: QueryableTraceEventSink) {}

  async timeSeries(input: LatencyTimeSeriesInput): Promise<readonly LatencyPoint[]> {
    const bucketSize = input.bucketSizeMs ?? LATENCY_DEFAULT_BUCKET_SIZE_MS;
    if (!Number.isFinite(bucketSize) || bucketSize <= 0) {
      throw new Error("LatencyQuery bucketSizeMs must be a positive finite number");
    }

    const durationsByBucket = new Map<number, number[]>();
    for (const event of this.collect(input)) {
      const durationMs = computeDurationMs(event);
      if (durationMs === undefined) {
        continue;
      }
      const bucketStart = Math.floor(event.startedAt.getTime() / bucketSize) * bucketSize;
      const bucket = durationsByBucket.get(bucketStart);
      if (bucket) {
        bucket.push(durationMs);
      } else {
        durationsByBucket.set(bucketStart, [durationMs]);
      }
    }

    return [...durationsByBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucketMs, durations]) => ({
        avgMs: roundedMean(durations),
        bucketStart: new Date(bucketMs),
        count: durations.length,
        p95Ms: percentileMs(durations, 0.95)
      }));
  }

  async summary(input: LatencySummaryInput): Promise<LatencySummary> {
    const durations: number[] = [];
    for (const event of this.collect(input)) {
      const durationMs = computeDurationMs(event);
      if (durationMs !== undefined) {
        durations.push(durationMs);
      }
    }
    return {
      avgMs: roundedMean(durations),
      count: durations.length,
      p50Ms: percentileMs(durations, 0.5),
      p95Ms: percentileMs(durations, 0.95),
      p99Ms: percentileMs(durations, 0.99)
    };
  }

  private collect(input: { from: Date; to: Date; spanName?: string; spanNamePrefix?: string }): readonly TraceEventInput[] {
    return this.sink
      .list()
      .filter((event) => matchesLatencyFilter(event, input));
  }
}

export class KyselyLatencyQuery implements LatencyQuery {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async timeSeries(input: LatencyTimeSeriesInput): Promise<readonly LatencyPoint[]> {
    const bucketSize = input.bucketSizeMs ?? LATENCY_DEFAULT_BUCKET_SIZE_MS;
    if (!Number.isFinite(bucketSize) || bucketSize <= 0) {
      throw new Error("LatencyQuery bucketSizeMs must be a positive finite number");
    }
    const bucketSeconds = Math.max(1, Math.floor(bucketSize / 1000));
    const filter = buildLatencySqlFilter(input);

    const rows = await sql<{
      bucket_start: Date | string;
      avg_ms: string | number | null;
      p95_ms: string | number | null;
      cnt: string | number;
    }>`
      SELECT
        to_timestamp(floor(extract(epoch from started_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket_start,
        AVG(extract(epoch from (ended_at - started_at)) * 1000)::FLOAT8 AS avg_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY extract(epoch from (ended_at - started_at)) * 1000)::FLOAT8 AS p95_ms,
        COUNT(*)::BIGINT AS cnt
      FROM trace_events
      WHERE ended_at IS NOT NULL
        AND started_at >= ${input.from}
        AND started_at < ${input.to}
        ${filter}
      GROUP BY bucket_start
      ORDER BY bucket_start
    `.execute(this.db);

    return rows.rows.map((row) => ({
      avgMs: Math.round(toNumberOrZero(row.avg_ms)),
      bucketStart: row.bucket_start instanceof Date ? row.bucket_start : new Date(row.bucket_start),
      count: Number(row.cnt),
      p95Ms: Math.round(toNumberOrZero(row.p95_ms))
    }));
  }

  async summary(input: LatencySummaryInput): Promise<LatencySummary> {
    const filter = buildLatencySqlFilter(input);

    const rows = await sql<{
      avg_ms: string | number | null;
      p50_ms: string | number | null;
      p95_ms: string | number | null;
      p99_ms: string | number | null;
      cnt: string | number;
    }>`
      SELECT
        AVG(extract(epoch from (ended_at - started_at)) * 1000)::FLOAT8 AS avg_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY extract(epoch from (ended_at - started_at)) * 1000)::FLOAT8 AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY extract(epoch from (ended_at - started_at)) * 1000)::FLOAT8 AS p95_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY extract(epoch from (ended_at - started_at)) * 1000)::FLOAT8 AS p99_ms,
        COUNT(*)::BIGINT AS cnt
      FROM trace_events
      WHERE ended_at IS NOT NULL
        AND started_at >= ${input.from}
        AND started_at < ${input.to}
        ${filter}
    `.execute(this.db);

    const row = rows.rows[0];
    return {
      avgMs: Math.round(toNumberOrZero(row?.avg_ms ?? null)),
      count: Number(row?.cnt ?? 0),
      p50Ms: Math.round(toNumberOrZero(row?.p50_ms ?? null)),
      p95Ms: Math.round(toNumberOrZero(row?.p95_ms ?? null)),
      p99Ms: Math.round(toNumberOrZero(row?.p99_ms ?? null))
    };
  }
}

function matchesLatencyFilter(
  event: TraceEventInput,
  input: { from: Date; to: Date; spanName?: string; spanNamePrefix?: string }
): boolean {
  if (event.startedAt.getTime() < input.from.getTime() || event.startedAt.getTime() >= input.to.getTime()) {
    return false;
  }
  if (input.spanName !== undefined) {
    return event.name === input.spanName;
  }
  const prefix = input.spanNamePrefix ?? LATENCY_DEFAULT_SPAN_NAME_PREFIX;
  return prefix.length === 0 ? true : event.name.startsWith(prefix);
}

function buildLatencySqlFilter(input: { spanName?: string; spanNamePrefix?: string }) {
  if (input.spanName !== undefined) {
    return sql`AND name = ${input.spanName}`;
  }
  const prefix = input.spanNamePrefix ?? LATENCY_DEFAULT_SPAN_NAME_PREFIX;
  if (prefix.length === 0) {
    return sql``;
  }
  return sql`AND name LIKE ${`${prefix}%`}`;
}

function computeDurationMs(event: TraceEventInput): number | undefined {
  if (!event.endedAt) {
    return undefined;
  }
  const duration = event.endedAt.getTime() - event.startedAt.getTime();
  if (!Number.isFinite(duration)) {
    return undefined;
  }
  return duration >= 0 ? duration : 0;
}

function roundedMean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Math.round(sum / values.length);
}

function toNumberOrZero(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
