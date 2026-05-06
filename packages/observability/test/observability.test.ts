import { describe, expect, it } from "vitest";
import {
  createCacheStartupCheck,
  createMcpStartupCheck,
  createTenantSpanProcessor,
  createTraceEventInsert,
  InMemoryAgentMetrics,
  InMemoryFollowupSuggestionStore,
  InMemoryMuseTracer,
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
    expect(spans).toContainEqual(expect.objectContaining({ ended: true, name: "muse.agent.run" }));
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

  it("adds tenant span attributes from trace event metadata", async () => {
    const sinkEvents: unknown[] = [];
    const processor = createTenantSpanProcessor({
      async record(event) {
        sinkEvents.push(event);
      }
    });

    await processor.record({
      attributes: { workspaceId: "workspace-1" },
      name: "muse.agent.run",
      runId: "run-1",
      spanId: "span-1",
      stage: "agent",
      startedAt: new Date("2026-05-06T00:00:00.000Z")
    });

    expect(sinkEvents).toEqual([
      expect.objectContaining({
        attributes: {
          "tenant.id": "tenant-unknown",
          workspaceId: "workspace-1"
        }
      })
    ]);
  });
});
