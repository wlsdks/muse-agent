import { describe, expect, it } from "vitest";
import {
  AnthropicPromptCachingService,
  InMemoryCacheMetricsRecorder,
  InMemoryCacheStatsStore,
  InMemoryResponseCache,
  NoOpPromptCachingService,
  NoOpResponseCache,
  anonymousUserId,
  buildCacheKey,
  buildScopeFingerprint,
  cacheableModelRequest,
  cachedResponseFromModelResponse,
  estimateCostUsd,
  normalizeUserId,
  resolveIdentityScope,
  resolveProvider
} from "../src/index.js";

describe("cache keys", () => {
  it("builds deterministic keys with sorted tool names", () => {
    const command = {
      model: "openai/gpt-4o-mini",
      systemPrompt: "You are concise.",
      userPrompt: "Summarize this",
      userId: "user-1"
    };

    expect(buildCacheKey(command, ["write", "read"])).toBe(buildCacheKey(command, ["read", "write"]));
  });

  it("separates anonymous and explicit blank identities with the anonymous sentinel", () => {
    expect(normalizeUserId(undefined)).toBe(anonymousUserId);
    expect(normalizeUserId("   ")).toBe(anonymousUserId);
    expect(normalizeUserId("user-1")).toBe("user-1");
  });

  it("includes identity and tenant scope in the fingerprint", () => {
    const base = {
      metadata: { requesterEmail: "USER_ACCOUNT", tenantId: "tenant-1" },
      userPrompt: "Hello"
    };
    const first = buildScopeFingerprint(base, []);
    const second = buildScopeFingerprint({ ...base, metadata: { requesterEmail: "OTHER_ACCOUNT" } }, []);

    expect(first).not.toBe(second);
    expect(resolveIdentityScope(base.metadata)).toBe("user_account");
  });
});

describe("response caches", () => {
  it("stores non-blank values with ttl and least-recent eviction", () => {
    let now = 1_000;
    const cache = new InMemoryResponseCache({ maxSize: 2, now: () => now, ttlMs: 100 });

    cache.put("a", { cachedAt: now, content: "A", metadata: {}, toolsUsed: [] });
    cache.put("blank", { cachedAt: now, content: "  ", metadata: {}, toolsUsed: [] });
    cache.put("b", { cachedAt: now, content: "B", metadata: {}, toolsUsed: [] });
    expect(cache.get("blank")).toBeUndefined();
    expect(cache.get("a")?.content).toBe("A");

    cache.put("c", { cachedAt: now, content: "C", metadata: {}, toolsUsed: [] });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size()).toBe(2);

    now += 100;
    expect(cache.get("a")).toBeUndefined();
  });

  it("invalidates exact keys and glob-like patterns", () => {
    const cache = new InMemoryResponseCache();
    cache.put("tenant:one:a", { cachedAt: Date.now(), content: "A", metadata: {}, toolsUsed: [] });
    cache.put("tenant:one:b", { cachedAt: Date.now(), content: "B", metadata: {}, toolsUsed: [] });
    cache.put("tenant:two:a", { cachedAt: Date.now(), content: "C", metadata: {}, toolsUsed: [] });

    expect(cache.invalidate("tenant:two:a")).toBe(true);
    expect(cache.invalidateByPattern("tenant:one:*")).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("no-op cache never stores values", () => {
    const cache = new NoOpResponseCache();

    cache.put("key", { cachedAt: Date.now(), content: "value", metadata: {}, toolsUsed: [] });

    expect(cache.get("key")).toBeUndefined();
    expect(cache.invalidate("key")).toBe(false);
    expect(cache.invalidateByPattern("*")).toBe(0);
  });
});

describe("cache metrics", () => {
  it("records hit and miss snapshots with provider tags", () => {
    const stats = new InMemoryCacheStatsStore();
    const metrics = new InMemoryCacheMetricsRecorder(stats);

    metrics.recordExactHit("gpt-4o");
    metrics.recordSemanticHit(1.5, "claude-3-haiku");
    metrics.recordMiss("unknown-model");
    metrics.recordEstimatedCostSaved("gpt-4o-mini", 1_000, 500);

    expect(metrics.snapshot()).toMatchObject({
      exactHits: 1,
      hitsByProvider: { anthropic: 1, openai: 1 },
      misses: 1,
      missesByProvider: { unknown: 1 },
      semanticHits: 1,
      semanticSimilarityScores: [1]
    });
    expect(metrics.snapshot().estimatedCostSavedUsd).toBeGreaterThan(0);
  });

  it("estimates cost and provider from model names", () => {
    expect(estimateCostUsd("gpt-4o-mini", 1_000, 1_000)).toBeCloseTo(0.00075);
    expect(resolveProvider("claude-3-haiku")).toBe("anthropic");
    expect(resolveProvider("unknown-model")).toBe("unknown");
  });
});

describe("prompt caching", () => {
  it("applies Anthropic ephemeral prompt cache options over the token threshold", () => {
    const service = new AnthropicPromptCachingService({ minCacheableTokens: 100 });

    expect(service.applyCaching({ temperature: 0 }, "anthropic", 100)).toMatchObject({
      promptCache: {
        cacheSystemPrompt: true,
        cacheTools: true,
        type: "ephemeral"
      }
    });
    expect(service.applyCaching({ temperature: 0 }, "openai", 100)).toEqual({ temperature: 0 });
  });

  it("extracts cache metrics from native usage objects", () => {
    const service = new AnthropicPromptCachingService();

    expect(
      service.extractCacheMetrics({
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
        input_tokens: 30
      })
    ).toEqual({
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20,
      regularInputTokens: 30
    });
    expect(new NoOpPromptCachingService().extractCacheMetrics({ input_tokens: 1 })).toBeUndefined();
  });
});

describe("model response helpers", () => {
  it("converts model requests and responses into cacheable shapes", () => {
    const command = cacheableModelRequest({
      messages: [
        { content: "system", role: "system" },
        { content: "hello", role: "user" }
      ],
      model: "gpt-4o"
    });
    const cached = cachedResponseFromModelResponse({
      id: "response-1",
      model: "gpt-4o",
      output: "answer",
      usage: { inputTokens: 1, outputTokens: 2 }
    });

    expect(command).toMatchObject({ model: "gpt-4o", systemPrompt: "system", userPrompt: "hello" });
    expect(cached).toMatchObject({ content: "answer", model: "gpt-4o", toolsUsed: [] });
  });
});
