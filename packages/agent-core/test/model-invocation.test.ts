import { describe, expect, it, vi } from "vitest";
import { DefaultCircuitBreaker, type FallbackStrategy, type RetryOptions } from "@muse/resilience";
import { ModelProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from "@muse/model";
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
      totalTokens: 10
    });
    expect(events[0]).not.toHaveProperty("tenantId");
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

// Failure-injection / chaos on the run() model-call seam (backlog P1 — the
// "harden the actuators against real-world failure modes" half of the human's
// directive). The existing tests above prove each resilience layer in isolation
// with a bare `{retryable:true}` flag; these prove the real CLASSIFICATION
// (4xx fail-fast vs 429/503/transient retry, via isRetryableProviderError +
// ModelProviderError.retryable) AND the COMPOSITION the architecture promises:
// retry → fallback → circuit-breaker, in one chain.
describe("invokeModel — failure injection (retry classification + retry→fallback→breaker)", () => {
  const base = (extra: Partial<Parameters<typeof invokeModel>[0]>): Parameters<typeof invokeModel>[0] => ({
    metrics: new InMemoryAgentMetrics(),
    provider: provider(async () => ({ id: "x", model: "m", output: "ok" })),
    request: baseRequest(),
    runId: "fi",
    tracer: new InMemoryMuseTracer(),
    ...extra,
  });

  it("4xx fails FAST — a non-retryable ModelProviderError is not retried even with maxAttempts:3", async () => {
    let attempts = 0;
    await expect(invokeModel(base({
      provider: provider(async () => { attempts += 1; throw new ModelProviderError("p", "404 model not found", false); }),
      retry: { initialDelayMs: 1, maxAttempts: 3 },
    }))).rejects.toBeInstanceOf(ModelProviderError);
    expect(attempts).toBe(1); // burned no retry budget on a permanent error
  });

  it("429 rate-limit IS retried (retryable=true) and succeeds within maxAttempts", async () => {
    let attempts = 0;
    const result = await invokeModel(base({
      provider: provider(async () => {
        attempts += 1;
        if (attempts < 3) throw new ModelProviderError("p", "429 rate limited", true);
        return { id: "ok", model: "m", output: "recovered after 429" };
      }),
      retry: { initialDelayMs: 1, maxAttempts: 3 },
    }));
    expect(attempts).toBe(3);
    expect(result.output).toBe("recovered after 429");
  });

  it("a malformed/unknown error (e.g. JSON parse failure) is treated as transient and retried", async () => {
    let attempts = 0;
    const result = await invokeModel(base({
      provider: provider(async () => {
        attempts += 1;
        if (attempts < 2) throw new SyntaxError("Unexpected token < in JSON at position 0");
        return { id: "ok", model: "m", output: "recovered" };
      }),
      retry: { initialDelayMs: 1, maxAttempts: 3 },
    }));
    expect(attempts).toBe(2);
    expect(result.output).toBe("recovered");
  });

  it("retry EXHAUSTED on a persistent 503 → the fallback strategy rescues the turn", async () => {
    let attempts = 0;
    const fallback: FallbackStrategy = { execute: async () => ({ id: "fb", model: "fallback/model", output: "fallback answer" }) };
    const result = await invokeModel(base({
      fallbackStrategy: fallback,
      provider: provider(async () => { attempts += 1; throw new ModelProviderError("p", "503 service unavailable", true); }),
      retry: { initialDelayMs: 1, maxAttempts: 3 },
    }));
    expect(attempts).toBe(3); // every retry attempt was spent before falling back
    expect(result.output).toBe("fallback answer");
  });

  it("retry→breaker: each exhausted-retry invocation is ONE breaker failure; the breaker opens and short-circuits without calling the provider", async () => {
    const breaker = new DefaultCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    let providerCalls = 0;
    const failing = provider(async () => { providerCalls += 1; throw new ModelProviderError("p", "503", true); });
    const invoke = () => invokeModel(base({ circuitBreaker: breaker, provider: failing, retry: { initialDelayMs: 1, maxAttempts: 2 } }));

    await invoke().catch(() => undefined);
    await invoke().catch(() => undefined);
    expect(breaker.state()).toBe("open");
    const callsBeforeBlocked = providerCalls; // 2 invocations × 2 attempts = 4

    await expect(invoke()).rejects.toThrow();
    expect(providerCalls).toBe(callsBeforeBlocked); // open breaker short-circuited — provider untouched
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

  it("estimates a positive estimatedCostUsd from the model name + token counts when pricing is known", async () => {
    const sink = new InMemoryTokenUsageSink();
    await recordTokenUsageEvent({
      provider: provider(async () => ({ id: "x", model: "m", output: "" })),
      response: {
        id: "x",
        model: "openai/gpt-4o-mini",
        output: "",
        usage: { inputTokens: 1_000, outputTokens: 1_000 }
      },
      runId: "rt-cost-known",
      stepType: "act",
      tokenUsageSink: sink,
      tracer: new InMemoryMuseTracer()
    });
    const event = sink.list()[0];
    expect(event?.estimatedCostUsd).toBeGreaterThan(0);
    // gpt-4o-mini ≈ $0.00015/1k input + $0.0006/1k output → ~0.00075 for 1k+1k
    expect(event?.estimatedCostUsd).toBeCloseTo(0.00075, 5);
  });

  it("omits estimatedCostUsd when the model has no known pricing (cost computes to 0)", async () => {
    const sink = new InMemoryTokenUsageSink();
    await recordTokenUsageEvent({
      provider: provider(async () => ({ id: "x", model: "m", output: "" })),
      response: { id: "x", model: "diagnostic/smoke", output: "", usage: { inputTokens: 0, outputTokens: 0 } },
      runId: "rt-cost-zero",
      stepType: "act",
      tokenUsageSink: sink,
      tracer: new InMemoryMuseTracer()
    });
    const event = sink.list()[0];
    expect(event?.estimatedCostUsd).toBeUndefined();
  });

});
