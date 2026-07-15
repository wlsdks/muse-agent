// Cost/provider-attribution cluster split out of index.ts (PC-barrel cleanup):
// the stats/metrics recorders and the provider-resolution + pricing table
// they depend on are used ONLY by each other, never by the response-cache
// or prompt-cache classes that remain in index.ts — a self-contained module
// with zero runtime dependency back on index.ts (index.ts re-exports these
// symbols so existing importers of "@muse/cache" see no change).
import { knownModelPrefixes, parseModelName } from "@muse/model";
import { clamp } from "@muse/shared";

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

export const cacheUnknownModel = "unknown";

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
