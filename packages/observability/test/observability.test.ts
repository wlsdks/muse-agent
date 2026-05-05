import { describe, expect, it } from "vitest";
import {
  InMemoryAgentMetrics,
  InMemoryFollowupSuggestionStore,
  InMemoryMuseTracer,
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
