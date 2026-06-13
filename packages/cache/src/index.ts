import { createHash } from "node:crypto";
import { knownModelPrefixes, parseModelName, type ModelRequest, type ModelResponse } from "@muse/model";
import type { JsonObject, JsonValue } from "@muse/shared";
import { escapeRegex } from "@muse/shared";

export type Awaitable<T> = T | Promise<T>;

export interface CachedResponse {
  readonly content: string;
  readonly toolsUsed: readonly string[];
  readonly metadata: JsonObject;
  readonly cachedAt: number;
  readonly model?: string;
}

export interface ResponseCache {
  get(key: string): Awaitable<CachedResponse | undefined>;
  put(key: string, response: CachedResponse): Awaitable<void>;
  invalidateAll(): void;
  invalidate?(key: string): boolean;
  invalidateByPattern?(pattern: string): number;
}

export interface AgentCacheCommand {
  readonly systemPrompt?: string;
  readonly userPrompt: string;
  readonly model?: string;
  readonly mode?: string;
  readonly responseFormat?: string;
  readonly responseSchema?: string;
  readonly userId?: string | null;
  readonly metadata?: JsonObject;
}

export interface InMemoryResponseCacheOptions {
  readonly maxSize?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface CacheStatsSnapshot {
  readonly exactHits: number;
  readonly semanticHits: number;
  readonly misses: number;
}

export interface CacheStatsStore {
  incrementExactHit(): void;
  incrementSemanticHit(): void;
  incrementMiss(): void;
  read(): CacheStatsSnapshot;
}

export interface CacheMetricsRecorder {
  recordExactHit(model?: string): void;
  recordSemanticHit(similarityScore: number, model?: string): void;
  recordMiss(model?: string): void;
  recordEstimatedCostSaved(model: string, estimatedInputTokens: number, estimatedOutputTokens: number): void;
}

export interface CacheMetricsSnapshot extends CacheStatsSnapshot {
  readonly estimatedCostSavedUsd: number;
  readonly semanticSimilarityScores: readonly number[];
  readonly hitsByProvider: Readonly<Record<string, number>>;
  readonly missesByProvider: Readonly<Record<string, number>>;
}

export interface PromptCacheMetrics {
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly regularInputTokens: number;
}

export interface PromptCachingOptions {
  readonly enabled?: boolean;
  readonly minCacheableTokens?: number;
  readonly cacheSystemPrompt?: boolean;
  readonly cacheTools?: boolean;
}

export interface PromptCache {
  applyCaching<T extends JsonObject>(options: T, provider: string, estimatedSystemPromptTokens: number): T;
  extractCacheMetrics(nativeUsage: unknown): PromptCacheMetrics | undefined;
}

export const cacheUnknownModel = "unknown";
export const anonymousUserId = "anonymous";

export const DEFAULT_RESPONSE_CACHE_MAX_SIZE = 1_000;
export const DEFAULT_RESPONSE_CACHE_TTL_MS = 60 * 60 * 1_000;
const defaultMaxSize = DEFAULT_RESPONSE_CACHE_MAX_SIZE;
const defaultTtlMs = DEFAULT_RESPONSE_CACHE_TTL_MS;
const identityMetadataKeys = [
  "requesterAccountId",
  "requesterEmail",
  "userEmail"
] as const;

export class NoOpResponseCache implements ResponseCache {
  get(): undefined {
    return undefined;
  }

  put(): void {}

  invalidateAll(): void {}

  invalidate(): boolean {
    return false;
  }

  invalidateByPattern(): number {
    return 0;
  }
}

export class InMemoryResponseCache implements ResponseCache {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CachedResponse>();

  constructor(options: InMemoryResponseCacheOptions = {}) {
    // `??` doesn't catch NaN / Infinity, and `Math.max(1, NaN) === NaN`
    // / `Math.max(1, Infinity) === Infinity`. Both let the `entries.size
    // > this.maxSize` eviction loop short-circuit (`X > NaN` and `X >
    // Infinity` are both false), so a corrupt option silently disabled
    // the bound — unbounded memory growth from a single typo'd
    // configurator. Same defect class as the scheduler / token-cost
    // finite guards.
    this.maxSize = Math.max(1, finiteOrDefault(options.maxSize, defaultMaxSize));
    this.ttlMs = Math.max(0, finiteOrDefault(options.ttlMs, defaultTtlMs));
    this.now = options.now ?? Date.now;
  }

  get(key: string): CachedResponse | undefined {
    const cached = this.entries.get(key);

    if (!cached) {
      return undefined;
    }

    if (this.isExpired(cached)) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached;
  }

  put(key: string, response: CachedResponse): void {
    if (response.content.trim().length === 0) {
      return;
    }

    this.entries.set(key, { ...response, cachedAt: response.cachedAt || this.now() });
    this.evictOverflow();
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  invalidateByPattern(pattern: string): number {
    const matcher = createPatternMatcher(pattern);
    let removed = 0;

    for (const key of this.entries.keys()) {
      if (matcher(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  private isExpired(response: CachedResponse): boolean {
    return this.ttlMs > 0 && this.now() - response.cachedAt >= this.ttlMs;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value as string | undefined;

      if (!oldest) {
        return;
      }

      this.entries.delete(oldest);
    }
  }
}

export class InMemoryCacheStatsStore implements CacheStatsStore {
  private exactHits = 0;
  private semanticHits = 0;
  private misses = 0;

  incrementExactHit(): void {
    this.exactHits += 1;
  }

  incrementSemanticHit(): void {
    this.semanticHits += 1;
  }

  incrementMiss(): void {
    this.misses += 1;
  }

  read(): CacheStatsSnapshot {
    return {
      exactHits: this.exactHits,
      misses: this.misses,
      semanticHits: this.semanticHits
    };
  }
}

export class NoOpCacheMetricsRecorder implements CacheMetricsRecorder {
  recordExactHit(): void {}
  recordSemanticHit(): void {}
  recordMiss(): void {}
  recordEstimatedCostSaved(): void {}
}

export class InMemoryCacheMetricsRecorder implements CacheMetricsRecorder {
  private readonly statsStore?: CacheStatsStore;
  private readonly semanticSimilarityScores: number[] = [];
  private readonly hitsByProvider = new Map<string, number>();
  private readonly missesByProvider = new Map<string, number>();
  private estimatedCostSavedUsd = 0;

  constructor(statsStore?: CacheStatsStore) {
    this.statsStore = statsStore;
  }

  recordExactHit(model = cacheUnknownModel): void {
    this.statsStore?.incrementExactHit();
    this.increment(this.hitsByProvider, resolveProvider(model));
  }

  recordSemanticHit(similarityScore: number, model = cacheUnknownModel): void {
    this.statsStore?.incrementSemanticHit();
    this.semanticSimilarityScores.push(clamp(similarityScore, 0, 1));
    this.increment(this.hitsByProvider, resolveProvider(model));
  }

  recordMiss(model = cacheUnknownModel): void {
    this.statsStore?.incrementMiss();
    this.increment(this.missesByProvider, resolveProvider(model));
  }

  recordEstimatedCostSaved(model: string, estimatedInputTokens: number, estimatedOutputTokens: number): void {
    this.estimatedCostSavedUsd += estimateCostUsd(model, estimatedInputTokens, estimatedOutputTokens);
  }

  snapshot(): CacheMetricsSnapshot {
    const stats = this.statsStore?.read() ?? { exactHits: 0, misses: 0, semanticHits: 0 };

    return {
      ...stats,
      estimatedCostSavedUsd: this.estimatedCostSavedUsd,
      hitsByProvider: Object.fromEntries(this.hitsByProvider),
      missesByProvider: Object.fromEntries(this.missesByProvider),
      semanticSimilarityScores: [...this.semanticSimilarityScores]
    };
  }

  private increment(bucket: Map<string, number>, key: string): void {
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
}

export class AnthropicPromptCache implements PromptCache {
  private readonly options: Required<PromptCachingOptions>;

  constructor(options: PromptCachingOptions = {}) {
    this.options = {
      cacheSystemPrompt: options.cacheSystemPrompt ?? true,
      cacheTools: options.cacheTools ?? true,
      enabled: options.enabled ?? true,
      minCacheableTokens: options.minCacheableTokens ?? 1_024
    };
  }

  applyCaching<T extends JsonObject>(options: T, provider: string, estimatedSystemPromptTokens: number): T {
    if (!this.shouldApply(provider, estimatedSystemPromptTokens)) {
      return options;
    }

    return {
      ...options,
      promptCache: {
        cacheSystemPrompt: this.options.cacheSystemPrompt,
        cacheTools: this.options.cacheTools,
        type: "ephemeral"
      }
    } as T;
  }

  extractCacheMetrics(nativeUsage: unknown): PromptCacheMetrics | undefined {
    if (!nativeUsage || typeof nativeUsage !== "object") {
      return undefined;
    }

    const usage = nativeUsage as Record<string, unknown>;
    const cacheCreationInputTokens = numberValue(usage.cache_creation_input_tokens);
    const cacheReadInputTokens = numberValue(usage.cache_read_input_tokens);
    const regularInputTokens = numberValue(usage.input_tokens);

    if (cacheCreationInputTokens === 0 && cacheReadInputTokens === 0 && regularInputTokens === 0) {
      return undefined;
    }

    return {
      cacheCreationInputTokens,
      cacheReadInputTokens,
      regularInputTokens
    };
  }

  private shouldApply(provider: string, estimatedSystemPromptTokens: number): boolean {
    return (
      this.options.enabled &&
      provider.toLowerCase() === "anthropic" &&
      estimatedSystemPromptTokens >= this.options.minCacheableTokens
    );
  }
}

export class NoOpPromptCache implements PromptCache {
  applyCaching<T extends JsonObject>(options: T): T {
    return options;
  }

  extractCacheMetrics(): undefined {
    return undefined;
  }
}

export function buildCacheKey(command: AgentCacheCommand, toolNames: readonly string[]): string {
  return sha256(`${buildScopeFingerprint(command, toolNames)}|${command.userPrompt}`);
}

export function buildScopeFingerprint(command: AgentCacheCommand, toolNames: readonly string[]): string {
  const metadata = command.metadata ?? {};
  const parts = [
    command.systemPrompt ?? "",
    [...toolNames].sort().join(","),
    command.model ?? "",
    command.mode ?? "react",
    command.responseFormat ?? "text",
    command.responseSchema ?? "",
    normalizeUserId(command.userId),
    stringMetadata(metadata, "sessionId"),
    resolveIdentityScope(metadata)
  ];

  return sha256(parts.join("|"));
}

export function cachedResponseFromModelResponse(response: ModelResponse, toolsUsed: readonly string[] = []): CachedResponse {
  return {
    cachedAt: Date.now(),
    content: response.output,
    metadata: response.usage ? { usage: response.usage as JsonValue } : {},
    model: response.model,
    toolsUsed: [...toolsUsed]
  };
}

export function cacheableModelRequest(request: ModelRequest): AgentCacheCommand {
  const userPrompt = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  const systemPrompt = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

  return {
    metadata: request.metadata,
    model: request.model,
    systemPrompt,
    userPrompt
  };
}

export function normalizeUserId(userId: string | null | undefined): string {
  const normalized = userId?.trim();
  return normalized && normalized.length > 0 ? normalized : anonymousUserId;
}

export function resolveIdentityScope(metadata: JsonObject): string {
  for (const key of identityMetadataKeys) {
    const value = metadata[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().toLowerCase();
    }
  }

  return "";
}

/**
 * Provider ids whose marginal inference cost is $0
 * (the model runs on the user's machine, no per-token billing).
 * `estimateCostUsd` short-circuits to 0 for these so the budget
 * meter / token-cost rollup don't manufacture phantom spend when
 * a user runs Qwen / Llama / etc. through Ollama or LM Studio.
 */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "lmstudio"]);

export function isLocalProvider(model: string): boolean {
  const provider = resolveProvider(model);
  return LOCAL_PROVIDERS.has(provider);
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  // Local inference is free — without this, defaultPricing is
  // applied per token and status/metrics report fictional spend.
  if (isLocalProvider(model)) {
    return 0;
  }
  const normalized = model.toLowerCase();
  const [inputRate, outputRate] =
    modelPricing.find(([prefix]) => normalized.includes(prefix))?.[1] ?? defaultPricing;

  // `Math.max(0, NaN) === NaN`, `Math.max(0, Infinity) === Infinity` —
  // either slips through and the result poisons the running budget
  // meter. A single corrupt usage payload from a provider must NOT
  // make every downstream cost rollup non-finite.
  const safeInput = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const safeOutput = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  return safeInput * inputRate + safeOutput * outputRate;
}

export function resolveProvider(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === cacheUnknownModel) {
    return cacheUnknownModel;
  }

  // Muse model strings carry the provider explicitly as "<providerId>/<modelId>"
  // (e.g. "diagnostic/smoke", "openai/gpt-4o", "ollama/llama3.2"). Trust that
  // structural cue first so newly-added providers attribute correctly without
  // editing the modelPrefixToProvider table.
  const parsed = parseModelName(trimmed);
  if (parsed.providerId && parsed.providerId.trim().length > 0) {
    return parsed.providerId.toLowerCase();
  }

  const normalized = trimmed.toLowerCase();
  const match = Object.entries(knownModelPrefixes()).find(([prefix]) => normalized.startsWith(prefix));
  return match?.[1] ?? cacheUnknownModel;
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function createPatternMatcher(pattern: string): (key: string) => boolean {
  if (!pattern.includes("*")) {
    return (key) => key.includes(pattern);
  }

  const escaped = pattern.split("*").map(escapeRegex).join(".*");
  const regex = new RegExp(`^${escaped}$`, "u");
  return (key) => regex.test(key);
}

function stringMetadata(metadata: JsonObject, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}


const defaultPricing = [0.001 / 1_000, 0.002 / 1_000] as const;

type ModelPricingEntry = readonly [string, readonly [number, number]];

const modelPricingEntries: readonly ModelPricingEntry[] = [
  ["gpt-4o-mini", [0.00015 / 1_000, 0.0006 / 1_000]],
  ["gpt-4o", [0.0025 / 1_000, 0.01 / 1_000]],
  ["gpt-4", [0.03 / 1_000, 0.06 / 1_000]],
  ["gpt-3.5-turbo", [0.0005 / 1_000, 0.0015 / 1_000]],
  ["claude-3-opus", [0.015 / 1_000, 0.075 / 1_000]],
  ["claude-3-sonnet", [0.003 / 1_000, 0.015 / 1_000]],
  ["claude-3-haiku", [0.00025 / 1_000, 0.00125 / 1_000]],
  ["gemini-1.5-pro", [0.00125 / 1_000, 0.005 / 1_000]],
  ["gemini-1.5-flash", [0.000075 / 1_000, 0.0003 / 1_000]],
  ["gemini-pro", [0.00025 / 1_000, 0.0005 / 1_000]]
];

const modelPricing: readonly ModelPricingEntry[] = [...modelPricingEntries].sort(
  (left, right) => right[0].length - left[0].length
);
