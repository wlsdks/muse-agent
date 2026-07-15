// Split out of index.ts (barrel cleanup): the model-fallback strategy is the
// one resilience primitive that talks to @muse/model provider/registry types
// directly, unlike circuit-breaker/retry/timeout which stay provider-agnostic
// core state machines. index.ts re-exports every symbol here byte-identically.
import { ModelProviderRegistry, parseModelName, type ModelMessage, type ModelProvider, type ModelResponse } from "@muse/model";
import type { JsonObject } from "@muse/shared";

import { isCancellationLikeError } from "./error-classifier.js";
import type { ResilienceMetricsRecorder } from "./index.js";

export interface FallbackCommand {
  readonly messages: readonly ModelMessage[];
  readonly metadata?: JsonObject;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Propagate turn cancellation into a fallback call; a fallback must never outlive its caller. */
  readonly signal?: AbortSignal;
}

export interface FallbackStrategy {
  execute(command: FallbackCommand, originalError: unknown): Promise<ModelResponse | undefined>;
}

export interface ModelFallbackStrategyOptions {
  readonly fallbackModels: readonly string[];
  readonly providerRegistry?: ModelProviderRegistry;
  readonly providers?: ReadonlyMap<string, ModelProvider> | readonly ModelProvider[];
  readonly metricsRecorder?: ResilienceMetricsRecorder;
}

export class ModelFallbackStrategy implements FallbackStrategy {
  private readonly fallbackModels: readonly string[];
  private readonly providerRegistry?: ModelProviderRegistry;
  private readonly providers = new Map<string, ModelProvider>();
  private readonly metricsRecorder: ResilienceMetricsRecorder;

  constructor(options: ModelFallbackStrategyOptions) {
    this.fallbackModels = options.fallbackModels;
    this.providerRegistry = options.providerRegistry;
    // `{}` structurally satisfies ResilienceMetricsRecorder (every method is
    // optional) and is byte-identical to index.ts's shared
    // `noOpResilienceMetricsRecorder` singleton — inlined here so this file
    // has no runtime (value) dependency back on index.ts, only the type-only
    // import above.
    this.metricsRecorder = options.metricsRecorder ?? {};

    if (options.providers && isProviderMap(options.providers)) {
      for (const [id, provider] of options.providers) {
        this.providers.set(id, provider);
      }
    } else if (options.providers) {
      for (const provider of options.providers) {
        this.providers.set(provider.id, provider);
      }
    }
  }

  async execute(command: FallbackCommand, originalError: unknown): Promise<ModelResponse | undefined> {
    void originalError;

    for (const modelName of this.fallbackModels) {
      try {
        const provider = this.resolveProvider(modelName);
        const model = parseModelName(modelName).modelId;
        const response = await provider.generate({
          maxOutputTokens: command.maxOutputTokens,
          messages: command.messages,
          metadata: command.metadata,
          model,
          signal: command.signal,
          temperature: command.temperature
        });

        if (response.output.trim().length > 0) {
          this.metricsRecorder.recordFallbackAttempt?.(modelName, true);
          return response;
        }

        this.metricsRecorder.recordFallbackAttempt?.(modelName, false);
      } catch (error) {
        if (isCancellationLikeError(error)) {
          throw error;
        }

        this.metricsRecorder.recordFallbackAttempt?.(modelName, false);
      }
    }

    return undefined;
  }

  private resolveProvider(modelName: string): ModelProvider {
    if (this.providerRegistry) {
      return this.providerRegistry.getProvider(modelName);
    }

    const parsed = parseModelName(modelName);
    const provider = parsed.providerId ? this.providers.get(parsed.providerId) : undefined;

    if (!provider) {
      throw new Error(`No fallback provider registered for model: ${modelName}`);
    }

    return provider;
  }
}

function isProviderMap(
  providers: ReadonlyMap<string, ModelProvider> | readonly ModelProvider[]
): providers is ReadonlyMap<string, ModelProvider> {
  return providers instanceof Map;
}
