import { describe, expect, it } from "vitest";
import {
  AnthropicPromptCache,
  DEFAULT_RESPONSE_CACHE_MAX_SIZE,
  DEFAULT_RESPONSE_CACHE_TTL_MS,
  InMemoryCacheMetricsRecorder,
  InMemoryCacheStatsStore,
  InMemoryResponseCache,
  MAX_SEMANTIC_SIMILARITY_SAMPLES,
  NoOpPromptCache,
  NoOpResponseCache,
  anonymousUserId,
  buildCacheKey,
  buildScopeFingerprint,
  cacheableModelRequest,
  cachedResponseFromModelResponse,
  estimateCostUsd,
  isLocalProvider,
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

  it("includes identity scope in the fingerprint", () => {
    const base = {
      metadata: { requesterEmail: "USER_ACCOUNT" },
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

  it("constructor finite-guards maxSize and ttlMs against NaN / Infinity (a corrupt option must not silently disable the bounded-cache contract)", () => {
    // Pre-fix: `options.maxSize ?? defaultMaxSize` doesn't catch
    // NaN/Infinity, then `Math.max(1, NaN)` is NaN. The
    // `entries.size > NaN` eviction guard short-circuits (any
    // comparison with NaN is false), so the cache grew without
    // bound. Same threat model on `ttlMs: NaN` → `isExpired`
    // returns false → entries never expire.

    // maxSize: NaN must fall to the default (bounded growth).
    const nanCache = new InMemoryResponseCache({ maxSize: Number.NaN, now: () => 1_000, ttlMs: 1_000_000 });
    const overflow = DEFAULT_RESPONSE_CACHE_MAX_SIZE + 5;
    for (let index = 0; index < overflow; index += 1) {
      nanCache.put(`key-${index.toString()}`, {
        cachedAt: 1_000,
        content: `v${index.toString()}`,
        metadata: {},
        toolsUsed: []
      });
    }
    expect(nanCache.size(),
      `maxSize:NaN must fall to ${DEFAULT_RESPONSE_CACHE_MAX_SIZE.toString()} default — unbounded growth means the eviction loop short-circuited on NaN`
    ).toBe(DEFAULT_RESPONSE_CACHE_MAX_SIZE);

    // maxSize: Infinity must also fall to the default.
    const infCache = new InMemoryResponseCache({ maxSize: Number.POSITIVE_INFINITY, now: () => 1_000, ttlMs: 1_000_000 });
    for (let index = 0; index < overflow; index += 1) {
      infCache.put(`key-${index.toString()}`, {
        cachedAt: 1_000,
        content: `v${index.toString()}`,
        metadata: {},
        toolsUsed: []
      });
    }
    expect(infCache.size()).toBe(DEFAULT_RESPONSE_CACHE_MAX_SIZE);

    // ttlMs: NaN must fall to the default — entries DO expire after
    // crossing the documented default cap, instead of becoming
    // permanent (the pre-fix `now() - cachedAt >= NaN` is always
    // false → no entry ever expires).
    let now = 1_000;
    const nanTtlCache = new InMemoryResponseCache({ maxSize: 10, now: () => now, ttlMs: Number.NaN });
    nanTtlCache.put("persist", { cachedAt: now, content: "fresh", metadata: {}, toolsUsed: [] });
    expect(nanTtlCache.get("persist")?.content).toBe("fresh");
    now += DEFAULT_RESPONSE_CACHE_TTL_MS + 1;
    expect(nanTtlCache.get("persist"), "ttlMs:NaN must fall to the default → entry expires after the default cap").toBeUndefined();

    // ttlMs: Infinity also falls to the default (same defect class).
    now = 1_000;
    const infTtlCache = new InMemoryResponseCache({ maxSize: 10, now: () => now, ttlMs: Number.POSITIVE_INFINITY });
    infTtlCache.put("persist", { cachedAt: now, content: "fresh", metadata: {}, toolsUsed: [] });
    now += DEFAULT_RESPONSE_CACHE_TTL_MS + 1;
    expect(infTtlCache.get("persist")).toBeUndefined();
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

  it("keeps semantic metric samples finite and bounded for long-lived runtimes", () => {
    const nonFinite = new InMemoryCacheMetricsRecorder();
    nonFinite.recordSemanticHit(Number.NaN);
    expect(nonFinite.snapshot().semanticSimilarityScores).toEqual([0]);

    const metrics = new InMemoryCacheMetricsRecorder();
    for (let index = 0; index <= MAX_SEMANTIC_SIMILARITY_SAMPLES; index += 1) {
      metrics.recordSemanticHit(index / MAX_SEMANTIC_SIMILARITY_SAMPLES);
    }
    const samples = metrics.snapshot().semanticSimilarityScores;
    expect(samples).toHaveLength(MAX_SEMANTIC_SIMILARITY_SAMPLES);
    expect(samples[0]).toBeCloseTo(1 / MAX_SEMANTIC_SIMILARITY_SAMPLES);
    expect(samples.at(-1)).toBe(1);
  });

  it("estimates cost and provider from model names", () => {
    expect(estimateCostUsd("gpt-4o-mini", 1_000, 1_000)).toBeCloseTo(0.00075);
    expect(resolveProvider("claude-3-haiku")).toBe("anthropic");
    expect(resolveProvider("unknown-model")).toBe("unknown");
  });

  it("trusts the explicit '<provider>/<model>' prefix for cache attribution", () => {
    // These were all attributed to 'unknown' before the parseModelName-aware
    // fix because the modelPrefixToProvider table only knows the *model*
    // prefix forms (gpt-, claude-, etc), not Muse's structural provider/model
    // wrapper. Without this fix, /admin/cache.hitsByProvider returned
    // { unknown: N } even when callers specified the provider explicitly.
    expect(resolveProvider("diagnostic/smoke")).toBe("diagnostic");
    expect(resolveProvider("ollama/llama3.2")).toBe("ollama");
    expect(resolveProvider("anthropic/claude-3-haiku")).toBe("anthropic");
    expect(resolveProvider("openrouter/anthropic/claude-3-haiku")).toBe("openrouter");
    expect(resolveProvider("OpenAI/gpt-4o")).toBe("openai");
  });

  it("estimateCostUsd returns 0 for local providers (Ollama / LM Studio)", () => {
    // Explicit `<provider>/<model>` form lands directly on the
    // local-provider allowlist.
    expect(estimateCostUsd("ollama/qwen3.5:9b-q4_K_M", 5000, 1000)).toBe(0);
    expect(estimateCostUsd("ollama/qwen3.6:27b", 100_000, 50_000)).toBe(0);
    expect(estimateCostUsd("lmstudio/some-local-tag", 1, 1)).toBe(0);

    // Bare local-prefixed names (no `ollama/` wrapper) — `qwen` and
    // `llama` map to ollama through knownModelPrefixes, so they
    // should also short-circuit.
    expect(estimateCostUsd("qwen3.5:9b-q4_K_M", 5000, 1000)).toBe(0);
    expect(estimateCostUsd("llama3.2", 5000, 1000)).toBe(0);

    // Non-local providers stay billed.
    expect(estimateCostUsd("gpt-4o-mini", 1_000, 1_000)).toBeCloseTo(0.00075);
    expect(estimateCostUsd("anthropic/claude-3-haiku", 1_000, 1_000)).toBeGreaterThan(0);

    // isLocalProvider mirrors the same classification.
    expect(isLocalProvider("ollama/qwen3.5:9b")).toBe(true);
    expect(isLocalProvider("qwen3.5:9b")).toBe(true);
    expect(isLocalProvider("lmstudio/foo")).toBe(true);
    expect(isLocalProvider("gpt-4o")).toBe(false);
    expect(isLocalProvider("anthropic/claude-3-haiku")).toBe(false);
  });

  it("estimateCostUsd clamps non-finite token counts to 0 so a corrupt provider usage payload can't poison the running budget meter", () => {
    // A provider returning NaN / Infinity for a token count (math
    // overflow, parse glitch, mocked-test fixture) would otherwise
    // make `Math.max(0, NaN) === NaN` flow through and the result
    // turn the cost rollup non-finite. The clamp keeps the cost
    // finite by treating any non-finite count as 0 for that side.
    const outputRate = 0.0006 / 1_000;
    const finiteOutputCost = 1_000 * outputRate;
    // NaN inputTokens → input contribution drops to 0; output side unchanged.
    expect(estimateCostUsd("gpt-4o-mini", Number.NaN, 1_000)).toBeCloseTo(finiteOutputCost);
    // Infinity → same; never returns Infinity.
    expect(estimateCostUsd("gpt-4o-mini", Number.POSITIVE_INFINITY, 1_000)).toBeCloseTo(finiteOutputCost);
    // Both sides bad → cost is 0, finite.
    expect(estimateCostUsd("gpt-4o-mini", Number.NaN, Number.NEGATIVE_INFINITY)).toBe(0);
    // The result is always finite — the property that load-bearing
    // for any downstream budget rollup that sums many calls.
    for (const [a, b] of [[Number.NaN, Number.NaN], [1_000, Number.NaN], [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]] as const) {
      expect(Number.isFinite(estimateCostUsd("gpt-4o-mini", a, b)), `cost for (${a.toString()}, ${b.toString()}) must be finite`).toBe(true);
    }
  });
});

describe("prompt caching", () => {
  it("applies Anthropic ephemeral prompt cache options over the token threshold", () => {
    const service = new AnthropicPromptCache({ minCacheableTokens: 100 });

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
    const service = new AnthropicPromptCache();

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
    expect(new NoOpPromptCache().extractCacheMetrics({ input_tokens: 1 })).toBeUndefined();
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
