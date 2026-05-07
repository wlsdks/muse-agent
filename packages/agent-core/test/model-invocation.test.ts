import { describe, expect, it, vi } from "vitest";
import { DefaultCircuitBreaker, type FallbackStrategy, type RetryOptions } from "@muse/resilience";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { InMemoryAgentMetrics, InMemoryMuseTracer, InMemoryTokenUsageSink } from "@muse/observability";
import { invokeModel, recordTokenUsageEvent } from "../src/model-invocation.js";

function provider(generate: (req: ModelRequest) => Promise<ModelResponse>): ModelProvider {
  return {
    id: "test-provider",
    generate,
    listModels: async () => [],
    stream: async function* () {}
  };
}

function baseRequest(): ModelRequest {
  return { messages: [{ content: "hi", role: "user" }], model: "test/model" };
}

describe("invokeModel", () => {
  it("calls provider.generate, records metrics + token-usage events when usage is present", async () => {
    const metrics = new InMemoryAgentMetrics();
    const tokenUsageSink = new InMemoryTokenUsageSink();
    const tracer = new InMemoryMuseTracer();

    const response = await invokeModel({
      metadata: { tenantId: "t-1" },
      metrics,
      provider: provider(async () => ({
        id: "r1",
        model: "test/model",
        output: "ok",
        usage: { inputTokens: 4, outputTokens: 6 }
      })),
      request: baseRequest(),
      runId: "run-mi-1",
      tokenUsageSink,
      tracer
    });

    expect(response.output).toBe("ok");
    expect(metrics.recordedEvents().some((event) => event.type === "token_usage")).toBe(true);
    const events = tokenUsageSink.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      completionTokens: 6,
      promptTokens: 4,
      provider: "test-provider",
      runId: "run-mi-1",
      tenantId: "t-1",
      totalTokens: 10
    });
  });

  it("falls back when the primary provider throws and a fallback strategy is configured", async () => {
    const fallback: FallbackStrategy = {
      execute: async () => ({ id: "fb", model: "fallback/model", output: "fallback answer" })
    };

    const result = await invokeModel({
      fallbackStrategy: fallback,
      metrics: new InMemoryAgentMetrics(),
      provider: provider(async () => {
        throw new Error("primary down");
      }),
      request: baseRequest(),
      runId: "run-mi-2",
      tracer: new InMemoryMuseTracer()
    });

    expect(result.output).toBe("fallback answer");
  });

  it("retries retryable errors up to maxAttempts before throwing", async () => {
    let attempts = 0;
    const retryOptions: RetryOptions = { initialDelayMs: 1, maxAttempts: 3 };
    const tracer = new InMemoryMuseTracer();
    const metrics = new InMemoryAgentMetrics();

    const result = await invokeModel({
      metrics,
      provider: provider(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("transient"), { retryable: true });
        }
        return { id: "ok", model: "test/model", output: "after retries" };
      }),
      request: baseRequest(),
      retry: retryOptions,
      runId: "run-mi-3",
      tracer
    });

    expect(attempts).toBe(3);
    expect(result.output).toBe("after retries");
  });

  it("opens the circuit breaker after repeated failures and short-circuits subsequent calls", async () => {
    const breaker = new DefaultCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const failingProvider = provider(async () => {
      throw new Error("boom");
    });

    for (let i = 0; i < 2; i += 1) {
      await invokeModel({
        circuitBreaker: breaker,
        metrics: new InMemoryAgentMetrics(),
        provider: failingProvider,
        request: baseRequest(),
        runId: `run-mi-4-${i}`,
        tracer: new InMemoryMuseTracer()
      }).catch(() => undefined);
    }

    expect(breaker.state()).toBe("open");
    await expect(invokeModel({
      circuitBreaker: breaker,
      metrics: new InMemoryAgentMetrics(),
      provider: failingProvider,
      request: baseRequest(),
      runId: "run-mi-4-blocked",
      tracer: new InMemoryMuseTracer()
    })).rejects.toThrow();
  });

  it("times out long provider calls when requestTimeoutMs is set", async () => {
    await expect(invokeModel({
      metrics: new InMemoryAgentMetrics(),
      provider: provider(() => new Promise((resolve) => setTimeout(() => resolve({ id: "slow", model: "m", output: "" }), 100))),
      request: baseRequest(),
      requestTimeoutMs: 10,
      runId: "run-mi-5",
      tracer: new InMemoryMuseTracer()
    })).rejects.toThrow();
  });
});

describe("recordTokenUsageEvent", () => {
  it("is a no-op when the sink is undefined", async () => {
    await expect(recordTokenUsageEvent({
      provider: provider(async () => ({ id: "x", model: "m", output: "" })),
      response: { id: "x", model: "m", output: "", usage: { inputTokens: 1, outputTokens: 1 } },
      runId: "r",
      stepType: "act",
      tracer: new InMemoryMuseTracer()
    })).resolves.toBeUndefined();
  });

  it("logs a tracer span and swallows the error when the sink throws", async () => {
    const tracer = new InMemoryMuseTracer();
    const failingSink = {
      record: vi.fn().mockRejectedValue(new Error("sink down"))
    };

    await expect(recordTokenUsageEvent({
      provider: provider(async () => ({ id: "x", model: "m", output: "" })),
      response: { id: "x", model: "m", output: "", usage: { inputTokens: 2, outputTokens: 3 } },
      runId: "rt-fail",
      stepType: "act",
      tokenUsageSink: failingSink as never,
      tracer
    })).resolves.toBeUndefined();
    expect(failingSink.record).toHaveBeenCalled();
    expect(tracer.recordedSpans().some((span) => span.name === "muse.token_usage.record_failed")).toBe(true);
  });

  it("omits tenantId when missing from metadata", async () => {
    const sink = new InMemoryTokenUsageSink();
    await recordTokenUsageEvent({
      provider: provider(async () => ({ id: "x", model: "m", output: "" })),
      response: { id: "x", model: "m", output: "", usage: { inputTokens: 1, outputTokens: 2 } },
      runId: "rt-no-tenant",
      stepType: "act",
      tokenUsageSink: sink,
      tracer: new InMemoryMuseTracer()
    });
    expect(sink.list()).toHaveLength(1);
    expect(sink.list()[0]?.tenantId).toBeUndefined();
  });
});
