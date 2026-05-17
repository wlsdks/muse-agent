import { describe, expect, it } from "vitest";
import {
  createCacheStartupCheck,
  createMcpStartupCheck,
  createTraceEventInsert,
  InMemoryAgentMetrics,
  createMuseObservabilitySnapshotProvider,
  InMemoryFollowupSuggestionStore,
  InMemoryLatencyQuery,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  InMemoryMuseTracer,
  InMemoryTokenCostQuery,
  InMemoryTokenUsageSink,
  InMemoryTraceEventSink,
  LATENCY_DEFAULT_SPAN_NAME_PREFIX,
  OpenTelemetryTraceEventSink,
  PersistedMuseTracer,
  PinoTraceEventLogger,
  TimescaleTraceEventExporter,
  StartupDoctor,
  createNoOpAgentMetrics,
  createNoOpMuseTracer
} from "../src/index.js";

describe("Muse tracer", () => {
  it("returns no-op spans that are safe after repeated calls", () => {
    const span = createNoOpMuseTracer().startSpan("muse.agent.run", { model: "test" });

    expect(() => {
      span.setAttribute("stage", "guard");
      span.setError(new Error("ignored"));
      span.end();
      span.end();
    }).not.toThrow();
  });

  it("records span attributes, errors, and idempotent end calls in memory", () => {
    const tracer = new InMemoryMuseTracer();
    const span = tracer.startSpan("muse.agent.run", { runId: "run-1" });

    span.setAttribute("model", "test-model");
    span.setError(new Error("model failed"));
    span.end();
    span.setAttribute("ignored", true);
    span.end();

    expect(tracer.recordedSpans()).toHaveLength(1);
    expect(tracer.recordedSpans()[0]).toMatchObject({
      attributes: { model: "test-model", runId: "run-1" },
      error: "model failed",
      name: "muse.agent.run"
    });
    expect(tracer.recordedSpans()[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("persists completed spans through a trace event sink", async () => {
    const events: unknown[] = [];
    const tracer = new PersistedMuseTracer({
      async record(event) {
        events.push(event);
      }
    });
    const span = tracer.startSpan("muse.agent.run", {
      runId: "run-1",
      stage: "agent"
    });

    span.setAttribute("model", "test-model");
    span.end();
    await tracer.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attributes: { model: "test-model", runId: "run-1", stage: "agent" },
      name: "muse.agent.run",
      runId: "run-1",
      stage: "agent"
    });
  });

  it("keeps persisted trace events queryable by run id with completed span boundaries", async () => {
    const sink = new InMemoryTraceEventSink();
    const tracer = new PersistedMuseTracer(sink);
    const run = tracer.startSpan("muse.agent.run", { "run.id": "diagnostic-run", stage: "run" });
    const model = tracer.startSpan("muse.model.generate", { "run.id": "diagnostic-run", stage: "model" });

    model.end();
    run.end();
    await tracer.flush();

    expect(sink.listByRunId("diagnostic-run")).toEqual([
      expect.objectContaining({
        endedAt: expect.any(Date),
        name: "muse.model.generate",
        runId: "diagnostic-run",
        stage: "model",
        startedAt: expect.any(Date)
      }),
      expect.objectContaining({
        endedAt: expect.any(Date),
        name: "muse.agent.run",
        runId: "diagnostic-run",
        stage: "run",
        startedAt: expect.any(Date)
      })
    ]);
    expect(sink.listByRunId("other-run")).toEqual([]);
  });

  it("builds trace event inserts for the persisted database table", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");

    expect(createTraceEventInsert({
      attributes: { model: "test" },
      endedAt: now,
      name: "muse.agent.run",
      runId: "run-1",
      spanId: "span-1",
      stage: "agent",
      startedAt: now
    })).toEqual({
      attributes: { model: "test" },
      ended_at: now,
      name: "muse.agent.run",
      parent_span_id: null,
      run_id: "run-1",
      span_id: "span-1",
      stage: "agent",
      started_at: now
    });
  });
});

describe("follow-up suggestion stats", () => {
  it("aggregates impressions and clicks by category inside the requested window", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const store = new InMemoryFollowupSuggestionStore({ now: () => now });

    store.recordImpression({
      category: "operations",
      channelId: "channel-1",
      suggestionId: "suggestion-1",
      userId: "user-1"
    });
    store.recordImpression({
      category: "operations",
      channelId: "channel-1",
      suggestionId: "suggestion-2",
      userId: "user-1"
    });
    store.recordClick({
      category: "operations",
      channelId: "channel-1",
      suggestionId: "suggestion-1",
      userId: "user-1"
    });
    store.recordImpression({
      category: "stale",
      channelId: "channel-1",
      occurredAt: new Date("2026-05-04T23:59:59.000Z"),
      suggestionId: "suggestion-old",
      userId: "user-1"
    });

    expect(store.aggregateStats(24 * 60 * 60 * 1000)).toEqual({
      byCategory: [{ category: "operations", clicks: 1, ctr: 0.5, impressions: 2 }],
      ctr: 0.5,
      totalClicks: 1,
      totalImpressions: 2
    });
  });
});

describe("agent metrics", () => {
  it("provides no-op metrics for disabled observability", () => {
    const metrics = createNoOpAgentMetrics();

    expect(() => {
      metrics.recordGuardRejection("guard", "blocked");
      metrics.recordOutputGuardAction("output", "allowed", "");
      metrics.recordTokenUsage({ inputTokens: 1, outputTokens: 2 });
    }).not.toThrow();
  });

  it("records metric events in memory for tests and local diagnostics", () => {
    const metrics = new InMemoryAgentMetrics();

    metrics.recordAgentRun({
      durationMs: 42,
      model: "test-model",
      runId: "run-1",
      status: "completed"
    });
    metrics.recordGuardRejection("input", "blocked");
    metrics.recordOutputGuardAction("output", "modified", "masked");
    metrics.recordTokenUsage({ inputTokens: 2, outputTokens: 3 });

    expect(metrics.recordedEvents().map((event) => event.type)).toEqual([
      "agent_run",
      "guard_rejection",
      "output_guard_action",
      "token_usage"
    ]);
  });
});

describe("startup doctor and log export", () => {
  it("reports unhealthy required startup checks with diagnostic details", async () => {
    const doctor = new StartupDoctor([
      {
        id: "database",
        required: true,
        run: async () => ({ details: { message: "connection refused" }, ok: false })
      },
      {
        id: "mcp",
        required: false,
        run: async () => ({ details: { connected: false }, ok: false })
      }
    ]);

    await expect(doctor.run()).resolves.toEqual({
      checks: [
        {
          details: { message: "connection refused" },
          id: "database",
          ok: false,
          required: true
        },
        {
          details: { connected: false },
          id: "mcp",
          ok: false,
          required: false
        }
      ],
      ok: false
    });
  });

  it("creates cache and MCP startup checks from live probes", async () => {
    const cacheCheck = createCacheStartupCheck({
      get: (key) => key,
      put: () => undefined
    });
    const mcpCheck = createMcpStartupCheck({
      listServers: () => [
        { healthy: true, name: "docs" },
        { healthy: false, name: "local" }
      ]
    });

    await expect(cacheCheck.run()).resolves.toEqual({
      details: { configured: true, probeKey: "__muse_startup_probe__" },
      ok: true
    });
    await expect(mcpCheck.run()).resolves.toEqual({
      details: { serverCount: 2, unhealthy: ["local"] },
      ok: false
    });
  });

  it("exports trace events through a pino-compatible logger", async () => {
    const logs: unknown[] = [];
    const logger = new PinoTraceEventLogger({
      info: (payload, message) => {
        logs.push({ message, payload });
      }
    });

    await logger.record({
      attributes: { model: "test-model" },
      endedAt: new Date("2026-05-06T00:00:01.000Z"),
      name: "muse.agent.run",
      runId: "run-1",
      spanId: "span-1",
      stage: "agent",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    });

    expect(logs).toEqual([
      {
        message: "muse trace event",
        payload: {
          attributes: { model: "test-model" },
          durationMs: 1000,
          name: "muse.agent.run",
          runId: "run-1",
          spanId: "span-1",
          stage: "agent"
        }
      }
    ]);
  });

  it("exports trace events through an OpenTelemetry-compatible tracer", async () => {
    const spans: unknown[] = [];
    const sink = new OpenTelemetryTraceEventSink({
      startSpan: (name, options) => {
        const span = {
          end: () => {
            spans.push({ ended: true, name, options });
          },
          recordException: (error: unknown) => {
            spans.push({ error });
          },
          setAttribute: (key: string, value: unknown) => {
            spans.push({ key, value });
          },
          setStatus: (status: { readonly code: number; readonly message?: string }) => {
            spans.push({ status });
          }
        };
        return span;
      }
    });

    await sink.record({
      attributes: { error: "failed", model: "test-model" },
      endedAt: new Date("2026-05-06T00:00:01.000Z"),
      name: "muse.agent.run",
      runId: "run-1",
      spanId: "span-1",
      stage: "agent",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    });

    expect(spans).toContainEqual({ key: "model", value: "test-model" });
    expect(spans).toContainEqual({ key: "run.id", value: "run-1" });
    expect(spans).toContainEqual({ error: "failed" });
    // OTel ERROR status (code 2) so the span isn't shown as OK.
    expect(spans).toContainEqual({ status: { code: 2, message: "failed" } });
    expect(spans).toContainEqual(expect.objectContaining({ ended: true, name: "muse.agent.run" }));

    // A successful span records no exception and no ERROR status.
    const okSpans: unknown[] = [];
    const okSink = new OpenTelemetryTraceEventSink({
      startSpan: () => ({
        end: () => { okSpans.push({ ended: true }); },
        recordException: () => { okSpans.push({ exception: true }); },
        setAttribute: () => {},
        setStatus: (status: { readonly code: number }) => { okSpans.push({ status }); }
      })
    });
    await okSink.record({
      attributes: { model: "test-model" },
      endedAt: new Date("2026-05-06T00:00:01.000Z"),
      name: "muse.agent.run",
      runId: "run-2",
      spanId: "span-2",
      stage: "agent",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    });
    expect(okSpans).not.toContainEqual(expect.objectContaining({ exception: true }));
    expect(okSpans.some((s) => typeof s === "object" && s !== null && "status" in s)).toBe(false);
    expect(okSpans).toContainEqual({ ended: true });
  });

  it("exports trace events to a Timescale-compatible writer", async () => {
    const rows: unknown[] = [];
    const exporter = new TimescaleTraceEventExporter({
      insertTraceEvent: async (row) => {
        rows.push(row);
      }
    });

    await exporter.record({
      attributes: { tenantId: "tenant-1" },
      endedAt: new Date("2026-05-06T00:00:01.000Z"),
      name: "muse.agent.run",
      runId: "run-1",
      spanId: "span-1",
      stage: "agent",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    });

    expect(rows).toEqual([
      {
        attributes: { tenantId: "tenant-1" },
        durationMs: 1000,
        name: "muse.agent.run",
        runId: "run-1",
        spanId: "span-1",
        stage: "agent",
        time: new Date("2026-05-06T00:00:00.000Z")
      }
    ]);
  });

});

describe("InMemoryLatencyQuery", () => {
  async function recordSpan(
    sink: InMemoryTraceEventSink,
    options: {
      runId?: string;
      name?: string;
      stage?: string;
      startedAt: string;
      endedAt?: string;
    }
  ): Promise<void> {
    await sink.record({
      attributes: {},
      endedAt: options.endedAt ? new Date(options.endedAt) : undefined,
      name: options.name ?? "muse.agent.run",
      runId: options.runId ?? "run-1",
      spanId: `span-${options.startedAt}`,
      stage: options.stage ?? "agent",
      startedAt: new Date(options.startedAt)
    });
  }

  it("aggregates muse.agent.* spans into hourly buckets with avg, p95, count", async () => {
    const sink = new InMemoryTraceEventSink();
    await recordSpan(sink, { startedAt: "2026-05-07T10:00:00.000Z", endedAt: "2026-05-07T10:00:01.000Z" });
    await recordSpan(sink, { startedAt: "2026-05-07T10:30:00.000Z", endedAt: "2026-05-07T10:30:02.000Z" });
    await recordSpan(sink, { startedAt: "2026-05-07T10:45:00.000Z", endedAt: "2026-05-07T10:45:03.000Z" });
    await recordSpan(sink, { startedAt: "2026-05-07T11:00:00.000Z", endedAt: "2026-05-07T11:00:05.000Z" });
    await recordSpan(sink, { startedAt: "2026-05-07T11:15:00.000Z", endedAt: "2026-05-07T11:15:10.000Z" });

    const query = new InMemoryLatencyQuery(sink);
    const points = await query.timeSeries({
      from: new Date("2026-05-07T10:00:00.000Z"),
      to: new Date("2026-05-07T12:00:00.000Z")
    });

    expect(points).toEqual([
      {
        avgMs: 2000,
        bucketStart: new Date("2026-05-07T10:00:00.000Z"),
        count: 3,
        p95Ms: 2900
      },
      {
        avgMs: 7500,
        bucketStart: new Date("2026-05-07T11:00:00.000Z"),
        count: 2,
        p95Ms: 9750
      }
    ]);
  });

  it("filters out spans whose name does not match the default muse.agent. prefix", async () => {
    const sink = new InMemoryTraceEventSink();
    await recordSpan(sink, {
      endedAt: "2026-05-07T10:00:00.500Z",
      name: "muse.model.generate",
      startedAt: "2026-05-07T10:00:00.000Z"
    });
    await recordSpan(sink, {
      endedAt: "2026-05-07T10:00:02.000Z",
      name: "muse.agent.run",
      startedAt: "2026-05-07T10:00:00.000Z"
    });

    const query = new InMemoryLatencyQuery(sink);
    const summary = await query.summary({
      from: new Date("2026-05-07T09:00:00.000Z"),
      to: new Date("2026-05-07T11:00:00.000Z")
    });

    expect(summary.count).toBe(1);
    expect(summary.avgMs).toBe(2000);
  });

  it("supports overriding the bucket size and the span name filter", async () => {
    const sink = new InMemoryTraceEventSink();
    await recordSpan(sink, {
      endedAt: "2026-05-07T10:00:01.000Z",
      name: "muse.model.generate",
      startedAt: "2026-05-07T10:00:00.000Z"
    });
    await recordSpan(sink, {
      endedAt: "2026-05-07T10:14:01.000Z",
      name: "muse.model.generate",
      startedAt: "2026-05-07T10:14:00.000Z"
    });

    const query = new InMemoryLatencyQuery(sink);
    const points = await query.timeSeries({
      bucketSizeMs: 5 * 60 * 1000,
      from: new Date("2026-05-07T10:00:00.000Z"),
      spanName: "muse.model.generate",
      to: new Date("2026-05-07T11:00:00.000Z")
    });

    expect(points).toEqual([
      {
        avgMs: 1000,
        bucketStart: new Date("2026-05-07T10:00:00.000Z"),
        count: 1,
        p95Ms: 1000
      },
      {
        avgMs: 1000,
        bucketStart: new Date("2026-05-07T10:10:00.000Z"),
        count: 1,
        p95Ms: 1000
      }
    ]);
  });

  it("ignores spans without an endedAt timestamp", async () => {
    const sink = new InMemoryTraceEventSink();
    await recordSpan(sink, { startedAt: "2026-05-07T10:00:00.000Z" });
    await recordSpan(sink, {
      endedAt: "2026-05-07T10:00:02.000Z",
      startedAt: "2026-05-07T10:00:00.000Z"
    });

    const query = new InMemoryLatencyQuery(sink);
    const summary = await query.summary({
      from: new Date("2026-05-07T09:00:00.000Z"),
      to: new Date("2026-05-07T11:00:00.000Z")
    });

    expect(summary.count).toBe(1);
    expect(summary.avgMs).toBe(2000);
  });

  it("returns zeroed summary when no spans match the window", async () => {
    const sink = new InMemoryTraceEventSink();
    const query = new InMemoryLatencyQuery(sink);

    expect(
      await query.summary({
        from: new Date("2026-05-07T00:00:00.000Z"),
        to: new Date("2026-05-08T00:00:00.000Z")
      })
    ).toEqual({ avgMs: 0, count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });

    expect(
      await query.timeSeries({
        from: new Date("2026-05-07T00:00:00.000Z"),
        to: new Date("2026-05-08T00:00:00.000Z")
      })
    ).toEqual([]);
  });

  it("excludes spans outside the requested window boundaries", async () => {
    const sink = new InMemoryTraceEventSink();
    await recordSpan(sink, {
      endedAt: "2026-05-07T09:00:01.000Z",
      startedAt: "2026-05-07T09:00:00.000Z"
    });
    await recordSpan(sink, {
      endedAt: "2026-05-07T10:00:01.000Z",
      startedAt: "2026-05-07T10:00:00.000Z"
    });

    const query = new InMemoryLatencyQuery(sink);
    const summary = await query.summary({
      from: new Date("2026-05-07T09:30:00.000Z"),
      to: new Date("2026-05-07T11:00:00.000Z")
    });

    expect(summary.count).toBe(1);
  });

  it("computes p50/p95/p99 from a small sorted distribution", async () => {
    const sink = new InMemoryTraceEventSink();
    for (let index = 0; index < 100; index += 1) {
      const start = `2026-05-07T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
      const end = new Date(new Date(start).getTime() + (index + 1) * 100).toISOString();
      await recordSpan(sink, { endedAt: end, startedAt: start });
    }

    const query = new InMemoryLatencyQuery(sink);
    const summary = await query.summary({
      from: new Date("2026-05-07T10:00:00.000Z"),
      to: new Date("2026-05-07T13:00:00.000Z")
    });

    expect(summary.count).toBe(100);
    expect(summary.avgMs).toBe(5050);
    expect(summary.p50Ms).toBe(5050);
    expect(summary.p95Ms).toBeGreaterThanOrEqual(9500);
    expect(summary.p99Ms).toBeGreaterThanOrEqual(9900);
  });

  it("exposes a stable default span name prefix constant", () => {
    expect(LATENCY_DEFAULT_SPAN_NAME_PREFIX).toBe("muse.agent.");
  });
});

describe("InMemoryTokenCostQuery", () => {
  async function record(
    sink: InMemoryTokenUsageSink,
    overrides: {
      runId?: string;
      model?: string;
      provider?: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      estimatedCostUsd?: number;
      recordedAt: string;
    }
  ): Promise<void> {
    const promptTokens = overrides.promptTokens ?? 100;
    const completionTokens = overrides.completionTokens ?? 50;
    await sink.record({
      completionTokens,
      estimatedCostUsd: overrides.estimatedCostUsd ?? 0.01,
      model: overrides.model ?? "test-model",
      promptTokens,
      provider: overrides.provider ?? "test",
      recordedAt: new Date(overrides.recordedAt),
      runId: overrides.runId ?? "run-1",
      stepType: "act",
      totalTokens: overrides.totalTokens ?? promptTokens + completionTokens
    });
  }

  it("returns per-step usage for a given run id sorted by time", async () => {
    const sink = new InMemoryTokenUsageSink();
    await record(sink, { recordedAt: "2026-05-07T10:00:00.000Z", runId: "session-1" });
    await record(sink, {
      completionTokens: 70,
      promptTokens: 200,
      recordedAt: "2026-05-07T10:00:30.000Z",
      runId: "session-1",
      totalTokens: 270
    });
    await record(sink, { recordedAt: "2026-05-07T11:00:00.000Z", runId: "other-run" });

    const query = new InMemoryTokenCostQuery(sink);
    const rows = await query.bySession("session-1");

    expect(rows).toEqual([
      expect.objectContaining({ runId: "session-1", totalTokens: 150 }),
      expect.objectContaining({ runId: "session-1", totalTokens: 270 })
    ]);
  });

  it("groups daily usage by date and model with cost descending within a day", async () => {
    const sink = new InMemoryTokenUsageSink();
    await record(sink, {
      estimatedCostUsd: 0.05,
      model: "model-a",
      recordedAt: "2026-05-07T10:00:00.000Z"
    });
    await record(sink, {
      estimatedCostUsd: 0.20,
      model: "model-b",
      recordedAt: "2026-05-07T11:00:00.000Z"
    });
    await record(sink, {
      estimatedCostUsd: 0.10,
      model: "model-a",
      recordedAt: "2026-05-08T10:00:00.000Z"
    });

    const query = new InMemoryTokenCostQuery(sink);
    const rows = await query.daily({
      from: new Date("2026-05-07T00:00:00.000Z"),
      to: new Date("2026-05-09T00:00:00.000Z")
    });

    expect(rows.map((row) => `${row.day}|${row.model}|${row.totalCostUsd}`)).toEqual([
      "2026-05-08|model-a|0.1",
      "2026-05-07|model-b|0.2",
      "2026-05-07|model-a|0.05"
    ]);
  });

  it("returns the top-N most expensive runs in the window descending by cost", async () => {
    const sink = new InMemoryTokenUsageSink();
    await record(sink, { estimatedCostUsd: 0.10, recordedAt: "2026-05-07T10:00:00.000Z", runId: "cheap" });
    await record(sink, { estimatedCostUsd: 1.50, recordedAt: "2026-05-07T11:00:00.000Z", runId: "expensive" });
    await record(sink, { estimatedCostUsd: 0.50, recordedAt: "2026-05-07T12:00:00.000Z", runId: "medium" });

    const query = new InMemoryTokenCostQuery(sink);
    const rows = await query.topExpensive({
      from: new Date("2026-05-07T00:00:00.000Z"),
      limit: 2,
      to: new Date("2026-05-08T00:00:00.000Z")
    });

    expect(rows.map((row) => row.runId)).toEqual(["expensive", "medium"]);
  });

  it("excludes events outside the requested window", async () => {
    const sink = new InMemoryTokenUsageSink();
    await record(sink, { estimatedCostUsd: 1.0, recordedAt: "2026-05-06T23:00:00.000Z" });
    await record(sink, { estimatedCostUsd: 2.0, recordedAt: "2026-05-07T01:00:00.000Z" });

    const query = new InMemoryTokenCostQuery(sink);
    const rows = await query.daily({
      from: new Date("2026-05-07T00:00:00.000Z"),
      to: new Date("2026-05-08T00:00:00.000Z")
    });
    expect(rows).toEqual([expect.objectContaining({ totalCostUsd: 2.0 })]);
  });

  it("aggregates multiple events for a single run into one topExpensive entry", async () => {
    const sink = new InMemoryTokenUsageSink();
    await record(sink, { estimatedCostUsd: 0.40, recordedAt: "2026-05-07T10:00:00.000Z", runId: "run-x" });
    await record(sink, { estimatedCostUsd: 0.60, recordedAt: "2026-05-07T10:01:00.000Z", runId: "run-x" });

    const query = new InMemoryTokenCostQuery(sink);
    const rows = await query.topExpensive({
      from: new Date("2026-05-07T00:00:00.000Z"),
      limit: 5,
      to: new Date("2026-05-08T00:00:00.000Z")
    });
    expect(rows[0]).toMatchObject({ runId: "run-x", totalCostUsd: expect.closeTo(1.0, 5) });
  });

  it("ranks cost-tied runs by token volume (free local-LLM: every run is $0)", async () => {
    const sink = new InMemoryTokenUsageSink();
    await record(sink, { estimatedCostUsd: 0, recordedAt: "2026-05-07T10:00:00.000Z", runId: "small", totalTokens: 120 });
    await record(sink, { estimatedCostUsd: 0, recordedAt: "2026-05-07T11:00:00.000Z", runId: "huge", totalTokens: 9000 });
    await record(sink, { estimatedCostUsd: 0, recordedAt: "2026-05-07T12:00:00.000Z", runId: "mid", totalTokens: 3000 });

    const query = new InMemoryTokenCostQuery(sink);
    const rows = await query.topExpensive({
      from: new Date("2026-05-07T00:00:00.000Z"),
      limit: 3,
      to: new Date("2026-05-08T00:00:00.000Z")
    });

    expect(rows.map((row) => row.runId)).toEqual(["huge", "mid", "small"]);
  });
});

describe("SloAlertEvaluator", () => {
  function evaluator(overrides: Partial<{
    latencyThresholdMs: number;
    errorRateThreshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
    minSamples: number;
    now: () => number;
  }> = {}): { now: () => number; setNow: (n: number) => void; evaluator: SloAlertEvaluator } {
    let current = overrides.now ? overrides.now() : 1_000_000;
    const setNow = (next: number) => {
      current = next;
    };
    const evaluatorInstance = new SloAlertEvaluator({
      cooldownSeconds: overrides.cooldownSeconds ?? 60,
      errorRateThreshold: overrides.errorRateThreshold ?? 0.5,
      latencyThresholdMs: overrides.latencyThresholdMs ?? 1000,
      minSamples: overrides.minSamples ?? 5,
      now: () => current,
      windowSeconds: overrides.windowSeconds ?? 30
    });
    return { evaluator: evaluatorInstance, now: () => current, setNow };
  }

  it("returns no violations until min samples are recorded", () => {
    const { evaluator: ev } = evaluator({ minSamples: 5 });
    for (let i = 0; i < 4; i += 1) {
      ev.recordLatency(2_000);
    }
    expect(ev.evaluate()).toEqual([]);
  });

  it("flags a P95 latency violation once threshold is breached on enough samples", () => {
    const { evaluator: ev } = evaluator({ latencyThresholdMs: 1_000, minSamples: 5 });
    for (let i = 0; i < 5; i += 1) {
      ev.recordLatency(3_000);
    }
    const violations = ev.evaluate();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ type: "latency", currentValue: 3_000, threshold: 1_000 });
  });

  it("flags an error rate violation when failures exceed the threshold", () => {
    const { evaluator: ev } = evaluator({ errorRateThreshold: 0.4, minSamples: 5 });
    [false, false, false, true, true].forEach((s) => ev.recordResult(s));
    const violations = ev.evaluate();
    const errorRateViolation = violations.find((v) => v.type === "error_rate");
    expect(errorRateViolation).toMatchObject({ threshold: 0.4 });
    expect(errorRateViolation?.currentValue).toBeCloseTo(0.6, 5);
  });

  it("respects per-type cooldown so the same violation does not repeat back-to-back", () => {
    const { evaluator: ev, setNow } = evaluator({
      cooldownSeconds: 60,
      latencyThresholdMs: 1_000,
      minSamples: 5,
      windowSeconds: 600
    });
    for (let i = 0; i < 5; i += 1) {
      ev.recordLatency(3_000);
    }
    expect(ev.evaluate()).toHaveLength(1);

    // Within cooldown window: no repeat alert.
    setNow(1_010_000);
    expect(ev.evaluate()).toEqual([]);

    // Past cooldown and still inside the rolling window: alert again.
    setNow(1_120_000);
    expect(ev.evaluate()).toHaveLength(1);
  });

  it("evicts samples that fall outside the rolling window", () => {
    const { evaluator: ev, setNow } = evaluator({ minSamples: 3, windowSeconds: 10 });
    for (let i = 0; i < 5; i += 1) {
      ev.recordLatency(3_000);
    }
    setNow(1_011_000); // 11 seconds later — older samples expired.
    const snapshot = ev.snapshot();
    expect(snapshot.latencySamples).toBe(0);
    expect(snapshot.latencyP95Ms).toBeNull();
  });

  it("rejects invalid configuration in the constructor", () => {
    expect(() =>
      new SloAlertEvaluator({ cooldownSeconds: 0, errorRateThreshold: 1.5, latencyThresholdMs: 1_000, windowSeconds: 30 })
    ).toThrow(/errorRateThreshold/u);
    expect(() =>
      new SloAlertEvaluator({ cooldownSeconds: 0, errorRateThreshold: 0.1, latencyThresholdMs: -1, windowSeconds: 30 })
    ).toThrow(/latencyThresholdMs/u);
    expect(() =>
      new SloAlertEvaluator({ cooldownSeconds: 0, errorRateThreshold: 0.1, latencyThresholdMs: 1_000, windowSeconds: 0 })
    ).toThrow(/windowSeconds/u);
  });
});

describe("PromptDriftDetector", () => {
  it("returns no anomalies until min samples are collected", () => {
    const detector = new PromptDriftDetector({ deviationThreshold: 1, minSamples: 10, windowSize: 50 });
    for (let i = 0; i < 6; i += 1) {
      detector.recordInput(100);
    }
    expect(detector.evaluate()).toEqual([]);
  });

  it("detects a sudden upward shift in input length", () => {
    const detector = new PromptDriftDetector({ deviationThreshold: 1, minSamples: 10, windowSize: 100 });
    for (let i = 0; i < 10; i += 1) {
      detector.recordInput(100 + i);
    }
    for (let i = 0; i < 10; i += 1) {
      detector.recordInput(2_000 + i);
    }
    const anomalies = detector.evaluate();
    expect(anomalies.find((a) => a.type === "input_length")).toBeDefined();
    expect(anomalies.find((a) => a.type === "input_length")?.deviationFactor).toBeGreaterThan(1);
  });

  it("detects output drift independently of input", () => {
    const detector = new PromptDriftDetector({ deviationThreshold: 1, minSamples: 10, windowSize: 100 });
    for (let i = 0; i < 10; i += 1) {
      detector.recordOutput(50);
    }
    for (let i = 0; i < 10; i += 1) {
      detector.recordOutput(5_000);
    }
    expect(detector.evaluate().some((a) => a.type === "output_length")).toBe(true);
  });

  it("uses a stddev floor when the baseline distribution is uniform", () => {
    const detector = new PromptDriftDetector({ deviationThreshold: 0.5, minSamples: 6, windowSize: 50 });
    for (let i = 0; i < 6; i += 1) {
      detector.recordInput(100);
    }
    for (let i = 0; i < 6; i += 1) {
      detector.recordInput(800);
    }
    expect(detector.evaluate().length).toBeGreaterThan(0);
  });

  it("evicts oldest samples when the window is full", () => {
    const detector = new PromptDriftDetector({ minSamples: 5, windowSize: 5 });
    for (let i = 0; i < 20; i += 1) {
      detector.recordInput(i);
    }
    expect(detector.stats().sampleCount).toBe(5);
  });

  it("ignores negative or non-finite samples", () => {
    const detector = new PromptDriftDetector({ minSamples: 5, windowSize: 50 });
    detector.recordInput(-1);
    detector.recordInput(Number.NaN);
    detector.recordInput(Number.POSITIVE_INFINITY);
    expect(detector.stats().sampleCount).toBe(0);
  });

  it("rejects invalid configuration", () => {
    expect(() => new PromptDriftDetector({ windowSize: 0 })).toThrow(/windowSize/u);
    expect(() => new PromptDriftDetector({ deviationThreshold: -1 })).toThrow(/deviationThreshold/u);
    expect(() => new PromptDriftDetector({ minSamples: 0 })).toThrow(/minSamples/u);
  });

  it("returns a stats snapshot suitable for telemetry", () => {
    const detector = new PromptDriftDetector({ minSamples: 4, windowSize: 50 });
    [10, 20, 30, 40].forEach((value) => detector.recordInput(value));
    const stats = detector.stats();
    expect(stats.inputMean).toBe(25);
    expect(stats.sampleCount).toBe(4);
    expect(stats.inputStdDev).toBeGreaterThan(0);
  });
});

describe("MonthlyBudgetTracker", () => {
  it("returns 'ok' when no monthly limit is configured", () => {
    const tracker = new MonthlyBudgetTracker({ now: () => new Date("2026-05-15T00:00:00Z") });
    expect(tracker.recordCost(5)).toBe("ok");
    expect(tracker.snapshot().totalCostUsd).toBe(5);
  });

  it("transitions ok → warning → exceeded as cumulative cost crosses thresholds", () => {
    const tracker = new MonthlyBudgetTracker({
      monthlyLimitUsd: 10,
      now: () => new Date("2026-05-15T00:00:00Z"),
      warningPercent: 80
    });
    expect(tracker.recordCost(5)).toBe("ok");
    expect(tracker.recordCost(3.1)).toBe("warning");
    expect(tracker.recordCost(2.5)).toBe("exceeded");
  });

  it("resets the running total on month rollover", () => {
    let nowDate = new Date("2026-05-31T23:00:00Z");
    const tracker = new MonthlyBudgetTracker({ monthlyLimitUsd: 10, now: () => nowDate, warningPercent: 50 });
    tracker.recordCost(6);
    expect(tracker.snapshot().totalCostUsd).toBe(6);
    nowDate = new Date("2026-06-01T00:30:00Z");
    expect(tracker.recordCost(1)).toBe("ok");
    expect(tracker.snapshot().totalCostUsd).toBe(1);
    expect(tracker.snapshot().month).toBe("2026-06");
  });

  it("rolls the month over even when the first cost of the new month is invalid (NaN)", () => {
    let nowDate = new Date("2026-05-20T12:00:00Z");
    const tracker = new MonthlyBudgetTracker({ monthlyLimitUsd: 10, now: () => nowDate, warningPercent: 50 });
    tracker.recordCost(12); // previous month exceeded the limit
    expect(tracker.recordCost(0)).toBe("exceeded");

    nowDate = new Date("2026-06-01T00:05:00Z");
    // A NaN cost (provider returned a malformed number; `?? 0` does
    // NOT coerce NaN) is the first event of the new month — it must
    // not surface last month's "exceeded" for a $0 June.
    expect(tracker.recordCost(Number.NaN)).toBe("ok");
    const snap = tracker.snapshot();
    expect(snap.month).toBe("2026-06");
    expect(snap.totalCostUsd).toBe(0);
  });

  it("rejects invalid configuration", () => {
    expect(() => new MonthlyBudgetTracker({ monthlyLimitUsd: -1 })).toThrow(/monthlyLimitUsd/u);
    expect(() => new MonthlyBudgetTracker({ warningPercent: 0 })).toThrow(/warningPercent/u);
    expect(() => new MonthlyBudgetTracker({ warningPercent: 110 })).toThrow(/warningPercent/u);
  });

  it("snapshot exposes remainingUsd + percentUsed when a positive limit is configured (goal 113)", () => {
    const tracker = new MonthlyBudgetTracker({
      monthlyLimitUsd: 10,
      now: () => new Date("2026-05-15T00:00:00Z"),
      warningPercent: 80
    });

    // Fresh tracker: full remaining + 0% used.
    let snap = tracker.snapshot();
    expect(snap.remainingUsd).toBe(10);
    expect(snap.percentUsed).toBe(0);

    // After half the budget: half remaining, 50%.
    tracker.recordCost(5);
    snap = tracker.snapshot();
    expect(snap.remainingUsd).toBe(5);
    expect(snap.percentUsed).toBe(50);

    // Past the limit: remaining clamps to 0, percent clamps to 100
    // (so a dashboard never renders "remaining: $-2" or "112%").
    tracker.recordCost(7);  // total = 12
    snap = tracker.snapshot();
    expect(snap.remainingUsd).toBe(0);
    expect(snap.percentUsed).toBe(100);
    expect(snap.status).toBe("exceeded");
    // The raw running total stays accurate — only the derived
    // fields clamp.
    expect(snap.totalCostUsd).toBe(12);
  });

  it("snapshot omits remainingUsd + percentUsed when the budget is unlimited (goal 113)", () => {
    const tracker = new MonthlyBudgetTracker({ now: () => new Date("2026-05-15T00:00:00Z") });
    tracker.recordCost(5);
    const snap = tracker.snapshot();
    expect(snap.limitUsd).toBe(0);
    expect(snap.totalCostUsd).toBe(5);
    expect(snap.status).toBe("ok");
    // Both derived fields omitted (vs. NaN / Infinity / negative
    // numbers a naive divide-by-zero would produce).
    expect(snap.remainingUsd).toBeUndefined();
    expect(snap.percentUsed).toBeUndefined();
  });
});

describe("createMuseObservabilitySnapshotProvider", () => {
  it("returns an empty snapshot when no observability components are wired", async () => {
    const provider = createMuseObservabilitySnapshotProvider({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      windowDays: 1
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.generatedAt.toISOString()).toBe("2026-05-15T00:00:00.000Z");
    expect(snapshot.windowStart.toISOString()).toBe("2026-05-14T00:00:00.000Z");
    expect(snapshot.latency).toBeUndefined();
    expect(snapshot.tokenCost).toBeUndefined();
    expect(snapshot.slo).toBeUndefined();
    expect(snapshot.drift).toBeUndefined();
    expect(snapshot.cost).toBeUndefined();
    expect(snapshot.budget).toBeUndefined();
    expect(snapshot.followups).toBeUndefined();
  });

  it("includes latency summary when latencyQuery is configured", async () => {
    const sink = new InMemoryTraceEventSink();
    await sink.record({
      attributes: {},
      endedAt: new Date("2026-05-15T00:00:01.000Z"),
      name: "muse.agent.run",
      runId: "run-1",
      spanId: "span-1",
      stage: "agent",
      startedAt: new Date("2026-05-15T00:00:00.000Z")
    });
    const latencyQuery = new InMemoryLatencyQuery(sink);
    const provider = createMuseObservabilitySnapshotProvider({
      latencyQuery,
      now: () => new Date("2026-05-16T00:00:00.000Z")
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.latency?.count).toBe(1);
    expect(snapshot.latency?.avgMs).toBe(1_000);
  });

  it("aggregates token cost daily and topExpensive into one snapshot", async () => {
    const sink = new InMemoryTokenUsageSink();
    await sink.record({
      completionTokens: 100,
      estimatedCostUsd: 0.5,
      model: "test-model",
      promptTokens: 200,
      provider: "test",
      recordedAt: new Date("2026-05-15T00:00:00.000Z"),
      runId: "run-1",
      stepType: "act",
      totalTokens: 300
    });
    const tokenCostQuery = new InMemoryTokenCostQuery(sink);
    const provider = createMuseObservabilitySnapshotProvider({
      now: () => new Date("2026-05-16T00:00:00.000Z"),
      tokenCostQuery,
      windowDays: 7
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.tokenCost?.daily).toHaveLength(1);
    expect(snapshot.tokenCost?.topExpensive[0]?.runId).toBe("run-1");
  });

  it("includes SLO snapshot and current violations", async () => {
    const sloEvaluator = new SloAlertEvaluator({
      cooldownSeconds: 60,
      errorRateThreshold: 0.5,
      latencyThresholdMs: 1_000,
      minSamples: 3,
      now: () => 1_000_000,
      windowSeconds: 600
    });
    sloEvaluator.recordLatency(5_000);
    sloEvaluator.recordLatency(5_000);
    sloEvaluator.recordLatency(5_000);
    const provider = createMuseObservabilitySnapshotProvider({
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      sloEvaluator
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.slo?.latencyP95Ms).toBe(5_000);
    expect(snapshot.slo?.violations).toHaveLength(1);
  });

  it("includes drift stats when the driftDetector is configured", async () => {
    const driftDetector = new PromptDriftDetector({ minSamples: 4, windowSize: 50 });
    [10, 20, 30, 40].forEach((value) => driftDetector.recordInput(value));
    const provider = createMuseObservabilitySnapshotProvider({
      driftDetector,
      now: () => new Date("2026-05-15T00:00:00.000Z")
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.drift?.inputMean).toBe(25);
  });

  it("emits the budget snapshot when budgetTracker is provided", async () => {
    const budgetTracker = new MonthlyBudgetTracker({
      monthlyLimitUsd: 10,
      now: () => new Date("2026-05-15T00:00:00.000Z"),
      warningPercent: 50
    });
    budgetTracker.recordCost(6);
    const provider = createMuseObservabilitySnapshotProvider({
      budgetTracker,
      now: () => new Date("2026-05-15T00:00:00.000Z")
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.budget).toMatchObject({ status: "warning", totalCostUsd: 6, limitUsd: 10, month: "2026-05" });
  });

  it("forwards followup suggestion stats when the store is configured", async () => {
    const store = new InMemoryFollowupSuggestionStore();
    store.recordImpression({
      category: "jira",
      channelId: "C1",
      suggestionId: "jira_123",
      userId: "U1"
    });
    const provider = createMuseObservabilitySnapshotProvider({
      followupSuggestionStore: store,
      now: () => new Date()
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.followups?.totalImpressions).toBe(1);
  });

  it("isolates failures so one broken component does not break the whole snapshot", async () => {
    const errors: unknown[] = [];
    const provider = createMuseObservabilitySnapshotProvider({
      latencyQuery: {
        summary: async () => {
          throw new Error("latency backend down");
        },
        timeSeries: async () => []
      },
      logger: (_message, error) => errors.push(error),
      now: () => new Date()
    });
    const snapshot = await provider.snapshot();
    expect(snapshot.latency).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
