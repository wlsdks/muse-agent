import { createHash } from "node:crypto";
import type { ModelRequest, ModelResponse } from "@muse/model";
import { isRecord, escapeRegex, type JsonObject, type JsonValue } from "@muse/shared";

export {
  cacheUnknownModel,
  estimateCostUsd,
  InMemoryCacheMetricsRecorder,
  InMemoryCacheStatsStore,
  isLocalProvider,
  NoOpCacheMetricsRecorder,
  resolveProvider,
  type CacheMetricsRecorder,
  type CacheMetricsSnapshot,
  type CacheStatsSnapshot,
  type CacheStatsStore
} from "./cache-metrics.js";

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
    if (!isRecord(nativeUsage)) {
      return undefined;
    }

    const cacheCreationInputTokens = numberValue(nativeUsage.cache_creation_input_tokens);
    const cacheReadInputTokens = numberValue(nativeUsage.cache_read_input_tokens);
    const regularInputTokens = numberValue(nativeUsage.input_tokens);

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
  return sha256(`${buildScopeFingerprint(command, toolNames)}|${normalizeCacheText(command.userPrompt)}`);
}

/**
 * Normalize prompt text before it enters a cache key so trivially-different
 * renderings hash IDENTICALLY (PC-4): CRLF/CR → LF, strip per-line trailing
 * whitespace, trim the ends. Prompts differing only in line endings or
 * trailing spaces — common across platforms / re-renders — then share a
 * cache entry instead of missing. Pure + idempotent; only end-of-line /
 * end-of-string whitespace is removed, never semantic content.
 */
export function normalizeCacheText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();
}

export function buildScopeFingerprint(command: AgentCacheCommand, toolNames: readonly string[]): string {
  const metadata = command.metadata ?? {};
  const parts = [
    normalizeCacheText(command.systemPrompt ?? ""),
    [...new Set(toolNames)].sort().join(","),
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


function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
