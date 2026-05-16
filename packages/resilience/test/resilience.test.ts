import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import {
  CircuitBreakerOpenError,
  CircuitBreakerRegistry,
  DefaultCircuitBreaker,
  ModelFallbackStrategy,
  NoOpFallbackStrategy,
  RetryExhaustedError,
  TimeoutError,
  computeRetryDelay,
  retry,
  withTimeout
} from "../src/index.js";

describe("DefaultCircuitBreaker", () => {
  it("opens after consecutive failures and rejects calls until reset timeout", async () => {
    let now = 1_000;
    const breaker = new DefaultCircuitBreaker({
      failureThreshold: 2,
      name: "llm",
      now: () => now,
      resetTimeoutMs: 5_000
    });

    await expect(breaker.execute(() => Promise.reject(new Error("first")))).rejects.toThrow("first");
    expect(breaker.state()).toBe("closed");

    await expect(breaker.execute(() => Promise.reject(new Error("second")))).rejects.toThrow("second");
    expect(breaker.state()).toBe("open");
    await expect(breaker.execute(() => "not called")).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    now += 5_000;
    expect(breaker.state()).toBe("half_open");
  });

  it("closes after a successful half-open trial and resets failure count on success", async () => {
    let now = 0;
    const breaker = new DefaultCircuitBreaker({
      failureThreshold: 2,
      now: () => now,
      resetTimeoutMs: 100
    });

    await breaker.execute(() => "ok");
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    await breaker.execute(() => "recovered before threshold");
    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    expect(breaker.state()).toBe("closed");

    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    expect(breaker.state()).toBe("open");

    now += 100;
    await expect(breaker.execute(() => "trial")).resolves.toBe("trial");
    expect(breaker.state()).toBe("closed");
    expect(breaker.metrics().failureCount).toBe(0);
  });

  it("does not count abort-like errors as circuit failures", async () => {
    const breaker = new DefaultCircuitBreaker({ failureThreshold: 1 });
    const abort = new Error("cancelled");
    abort.name = "AbortError";

    await expect(breaker.execute(() => Promise.reject(abort))).rejects.toThrow("cancelled");

    expect(breaker.state()).toBe("closed");
    expect(breaker.metrics().failureCount).toBe(0);
  });

  it("records state transitions through the metrics recorder", async () => {
    const transitions: string[] = [];
    let now = 0;
    const breaker = new DefaultCircuitBreaker({
      failureThreshold: 1,
      metricsRecorder: {
        recordCircuitBreakerStateChange: (name, from, to) => transitions.push(`${name}:${from}->${to}`)
      },
      name: "mcp:search",
      now: () => now,
      resetTimeoutMs: 1
    });

    await expect(breaker.execute(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    now += 1;
    expect(breaker.state()).toBe("half_open");

    expect(transitions).toEqual(["mcp:search:closed->open", "mcp:search:open->half_open"]);
  });
});

describe("CircuitBreakerRegistry", () => {
  it("creates isolated named breakers and evicts by least recent access", () => {
    const registry = new CircuitBreakerRegistry({ maxBreakers: 2 });

    const first = registry.get("llm");
    registry.get("mcp");
    registry.get("llm");
    registry.get("rag");

    expect(registry.getIfExists("llm")).toBe(first);
    expect(registry.getIfExists("mcp")).toBeUndefined();
    expect(registry.names()).toEqual(["llm", "rag"]);
  });
});

describe("retry and timeout", () => {
  it("retries retryable failures with deterministic backoff", async () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const value = await retry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary");
        }
        return "ok";
      },
      {
        initialDelayMs: 10,
        maxAttempts: 3,
        multiplier: 3,
        sleep: async (ms) => {
          sleeps.push(ms);
        }
      }
    );

    expect(value).toBe("ok");
    expect(sleeps).toEqual([10, 30]);
  });

  it("throws RetryExhaustedError when attempts are exhausted", async () => {
    await expect(retry(() => Promise.reject(new Error("down")), { maxAttempts: 2, sleep: async () => {} }))
      .rejects.toBeInstanceOf(RetryExhaustedError);
  });

  it("fails fast with the ORIGINAL error on a non-retryable failure (goal 174)", async () => {
    let attempts = 0;
    const rootCause = new Error("model 'xyz' not found");
    const result = await retry(
      () => {
        attempts += 1;
        return Promise.reject(rootCause);
      },
      {
        maxAttempts: 5,
        retryable: () => false,
        sleep: async () => {}
      }
    ).then(() => undefined, (e: unknown) => e);

    // Original error, NOT a RetryExhaustedError that lies "5 attempt(s)".
    expect(result).toBe(rootCause);
    expect(result).not.toBeInstanceOf(RetryExhaustedError);
    expect(attempts).toBe(1);
  });

  it("still exhausts + wraps when the error stays retryable (goal 174 regression)", async () => {
    let attempts = 0;
    const err = await retry(
      () => {
        attempts += 1;
        return Promise.reject(new Error("transient"));
      },
      { maxAttempts: 3, retryable: () => true, sleep: async () => {} }
    ).then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect((err as RetryExhaustedError).attempts).toBe(3);
    expect(attempts).toBe(3);
  });

  it("aborts operations that exceed the timeout", async () => {
    await expect(withTimeout(() => new Promise((resolve) => setTimeout(resolve, 20)), 1))
      .rejects.toBeInstanceOf(TimeoutError);
  });

  it("treats a non-finite timeout as no-timeout instead of an instant TimeoutError", async () => {
    // NaN / Infinity slip past `<= 0` and Node clamps the timer to
    // ~1ms — the operation must still run to completion, not die.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const value = await withTimeout(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 15)),
        bad
      );
      expect(value).toBe("done");
    }
  });

  it("computes bounded retry delays", () => {
    expect(computeRetryDelay(3, { initialDelayMs: 100, maxDelayMs: 250, multiplier: 2 })).toBe(250);
  });

  it("honors the injectable RNG for deterministic jitter", () => {
    const base = { initialDelayMs: 100, jitterRatio: 0.5 } as const;
    expect(computeRetryDelay(1, { ...base, random: () => 0 })).toBe(50);
    expect(computeRetryDelay(1, { ...base, random: () => 0.5 })).toBe(100);
    expect(computeRetryDelay(1, { ...base, random: () => 1 })).toBe(150);
  });

  it("keeps maxDelayMs a hard ceiling even with jitter", () => {
    const delay = computeRetryDelay(5, {
      initialDelayMs: 100,
      maxDelayMs: 250,
      multiplier: 2,
      jitterRatio: 1,
      random: () => 1
    });
    expect(delay).toBe(250);
    expect(delay).toBeLessThanOrEqual(250);
  });
});

describe("fallback strategies", () => {
  it("returns undefined for no-op fallback", async () => {
    await expect(new NoOpFallbackStrategy().execute({ messages: [] }, new Error("down"))).resolves.toBeUndefined();
  });

  it("tries fallback models in order until one returns non-blank output", async () => {
    const attempts: string[] = [];
    const provider = createProvider("openai", async (request) => {
      attempts.push(request.model);
      return {
        id: `response-${request.model}`,
        model: request.model,
        output: request.model === "backup" ? "fallback answer" : ""
      };
    });
    const strategy = new ModelFallbackStrategy({
      fallbackModels: ["openai/empty", "openai/backup"],
      providers: [provider]
    });

    const response = await strategy.execute({ messages: [{ content: "hello", role: "user" }] }, new Error("down"));

    expect(response?.output).toBe("fallback answer");
    expect(attempts).toEqual(["empty", "backup"]);
  });
});

function createProvider(
  id: string,
  generate: (request: ModelRequest) => Promise<ModelResponse>
): ModelProvider {
  return {
    generate,
    id,
    listModels: async () => [],
    stream: async function* () {}
  };
}
