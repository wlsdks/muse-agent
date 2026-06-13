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
  isCancellationLikeError,
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

  it("reset() on an open breaker fires the state-change recorder so manual operator intervention is observable", async () => {
    // Pre-fix `reset()` assigned `currentState = "closed"` directly,
    // bypassing `transition()`. An operator clearing a tripped
    // breaker through a manual call (admin endpoint, recovery
    // script) would silently flip the state from "open" to
    // "closed" — the metrics recorder, the dashboard, and any
    // alerting wired off state-change events would all miss the
    // intervention. Routing reset() through transition() closes
    // that gap while staying a no-op if the breaker was already
    // closed.
    const transitions: string[] = [];
    const breaker = new DefaultCircuitBreaker({
      failureThreshold: 1,
      metricsRecorder: {
        recordCircuitBreakerStateChange: (name, from, to) => transitions.push(`${name}:${from}->${to}`)
      },
      name: "llm:openai",
      resetTimeoutMs: 60_000
    });

    await expect(breaker.execute(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(transitions).toEqual(["llm:openai:closed->open"]);

    breaker.reset();
    expect(transitions).toEqual(["llm:openai:closed->open", "llm:openai:open->closed"]);

    // A second reset on an already-closed breaker is a no-op — no
    // metric is fired (transition()'s from===to early-return).
    breaker.reset();
    expect(transitions).toEqual(["llm:openai:closed->open", "llm:openai:open->closed"]);
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

  it("never returns a non-finite delay when a knob is NaN / Infinity", () => {
    // `?? default` doesn't catch NaN — pre-fix these poisoned the
    // whole computation and the retry loop slept NaN (→ 0ms,
    // backoff disabled). Each must fall back to a finite delay.
    for (const opts of [
      { initialDelayMs: Number.NaN },
      { initialDelayMs: 100, multiplier: Number.NaN },
      { initialDelayMs: 100, maxDelayMs: Number.NaN },
      { initialDelayMs: 100, jitterRatio: Number.NaN, random: () => 0.5 },
      { initialDelayMs: Number.POSITIVE_INFINITY }
    ] as const) {
      const d = computeRetryDelay(3, opts);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
    // A non-finite `attempt` is treated as the first attempt.
    expect(computeRetryDelay(Number.NaN, { initialDelayMs: 100, multiplier: 2 })).toBe(100);
    // A misbehaving injected RNG can't leak a non-finite delay.
    const bad = computeRetryDelay(1, { initialDelayMs: 100, jitterRatio: 0.5, random: () => Number.NaN });
    expect(Number.isFinite(bad)).toBe(true);
    // Valid inputs are unchanged (parity with the existing cases).
    expect(computeRetryDelay(3, { initialDelayMs: 100, maxDelayMs: 250, multiplier: 2 })).toBe(250);
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

  it("clamps misconfigured floor knobs: multiplier < 1 can't shrink backoff, maxDelayMs < initial can't cap below the floor", () => {
    // A multiplier below 1 would make each retry wait LESS (hammering a
    // failing provider). Math.max(1, …) clamps it so backoff never shrinks.
    expect(computeRetryDelay(3, { initialDelayMs: 100, multiplier: 0.5 })).toBe(100);
    // A maxDelayMs below initialDelayMs would cap the very first delay below
    // its configured floor. Math.max(initial, …) lifts the ceiling to initial.
    expect(computeRetryDelay(1, { initialDelayMs: 100, maxDelayMs: 50, multiplier: 2 })).toBe(100);
  });
});

describe("isCancellationLikeError", () => {
  it("recognises the abort signatures", () => {
    expect(isCancellationLikeError({ name: "AbortError" })).toBe(true);
    expect(isCancellationLikeError({ code: "ABORT_ERR" })).toBe(true);
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isCancellationLikeError(abortErr)).toBe(true);
    const domLike = new DOMException("aborted", "AbortError");
    expect(isCancellationLikeError(domLike)).toBe(true);
  });

  it("returns false for non-cancellation values (incl. primitives / nullish)", () => {
    expect(isCancellationLikeError(new Error("boom"))).toBe(false);
    expect(isCancellationLikeError({ name: "TypeError", code: "ERR_X" })).toBe(false);
    expect(isCancellationLikeError(null)).toBe(false);
    expect(isCancellationLikeError(undefined)).toBe(false);
    expect(isCancellationLikeError("AbortError")).toBe(false);
    expect(isCancellationLikeError(42)).toBe(false);
    expect(isCancellationLikeError({})).toBe(false);
  });

  it("short-circuits retry: a cancellation re-throws as-is, never retried or wrapped", async () => {
    let calls = 0;
    const abortErr = Object.assign(new Error("user cancelled"), { name: "AbortError" });
    await expect(
      retry(
        () => {
          calls += 1;
          throw abortErr;
        },
        { maxAttempts: 5, sleep: async () => {} }
      )
    ).rejects.toBe(abortErr);
    // Exactly one call — not retried — and not wrapped in RetryExhaustedError.
    expect(calls).toBe(1);
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

  it("returns undefined when EVERY fallback model yields blank output (exhausted, not a throw)", async () => {
    const strategy = new ModelFallbackStrategy({
      fallbackModels: ["openai/a", "openai/b"],
      providers: [createProvider("openai", async (request) => ({ id: "x", model: request.model, output: "" }))]
    });
    await expect(strategy.execute({ messages: [] }, new Error("down"))).resolves.toBeUndefined();
  });

  it("skips a fallback provider that THROWS and continues to the next (catch-and-continue)", async () => {
    const attempts: string[] = [];
    const strategy = new ModelFallbackStrategy({
      fallbackModels: ["openai/a", "openai/b"],
      providers: [createProvider("openai", async (request) => {
        attempts.push(request.model);
        if (request.model === "a") throw new Error("provider down");
        return { id: "x", model: request.model, output: "recovered" };
      })]
    });
    const response = await strategy.execute({ messages: [] }, new Error("down"));
    expect(response?.output).toBe("recovered");
    expect(attempts).toEqual(["a", "b"]); // proves it tried "a", caught, moved on
  });

  it("re-throws a cancellation mid-fallback instead of swallowing it (user abort must propagate)", async () => {
    const strategy = new ModelFallbackStrategy({
      fallbackModels: ["openai/a", "openai/b"],
      providers: [createProvider("openai", async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })]
    });
    await expect(strategy.execute({ messages: [] }, new Error("down")))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("records each fallback attempt's outcome through the metrics recorder", async () => {
    const seen: string[] = [];
    const strategy = new ModelFallbackStrategy({
      fallbackModels: ["openai/a", "openai/b"],
      metricsRecorder: { recordFallbackAttempt: (model, ok) => seen.push(`${model}:${ok.toString()}`) },
      providers: [createProvider("openai", async (request) => ({ id: "x", model: request.model, output: request.model === "b" ? "ok" : "" }))]
    });
    await strategy.execute({ messages: [] }, new Error("down"));
    expect(seen).toEqual(["openai/a:false", "openai/b:true"]);
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
