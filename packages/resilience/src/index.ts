import {
  ModelProviderRegistry,
  parseModelName,
  type ModelMessage,
  type ModelProvider,
  type ModelResponse
} from "@muse/model";
import type { JsonObject } from "@muse/shared";
import { finiteOr } from "@muse/shared";

export type Awaitable<T> = T | Promise<T>;
export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreaker {
  execute<T>(operation: () => Awaitable<T>): Promise<T>;
  state(): CircuitBreakerState;
  reset(): void;
  metrics(): CircuitBreakerMetrics;
}

export interface CircuitBreakerMetrics {
  readonly failureCount: number;
  readonly successCount: number;
  readonly state: CircuitBreakerState;
  readonly lastFailureTime?: number;
}

export interface ResilienceMetricsRecorder {
  recordCircuitBreakerStateChange?(name: string, from: CircuitBreakerState, to: CircuitBreakerState): void;
  recordFallbackAttempt?(model: string, success: boolean): void;
  recordRetryAttempt?(name: string, attempt: number, success: boolean): void;
}

export interface DefaultCircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
  readonly halfOpenMaxCalls?: number;
  readonly name?: string;
  readonly now?: () => number;
  readonly metricsRecorder?: ResilienceMetricsRecorder;
}

export interface CircuitBreakerRegistryOptions extends DefaultCircuitBreakerOptions {
  readonly maxBreakers?: number;
}

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly retryable?: (error: unknown, attempt: number) => boolean;
}

export interface RetryOptions extends RetryPolicy {
  readonly name?: string;
  readonly metricsRecorder?: ResilienceMetricsRecorder;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface FallbackCommand {
  readonly messages: readonly ModelMessage[];
  readonly metadata?: JsonObject;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
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

export const noOpResilienceMetricsRecorder: ResilienceMetricsRecorder = {};

const defaultFailureThreshold = 5;
const defaultResetTimeoutMs = 30_000;
const defaultHalfOpenMaxCalls = 1;
const defaultMaxBreakers = 1_000;
const defaultRetryAttempts = 3;
const defaultRetryDelayMs = 100;
const defaultRetryMultiplier = 2;

export class CircuitBreakerOpenError extends Error {
  readonly breakerName: string;

  constructor(breakerName = "unknown") {
    super(`Circuit breaker '${breakerName}' is open; call rejected`);
    this.name = "CircuitBreakerOpenError";
    this.breakerName = breakerName;
  }
}

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(`Retry attempts exhausted after ${attempts} attempt(s)`);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

export class DefaultCircuitBreaker implements CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly name: string;
  private readonly now: () => number;
  private readonly metricsRecorder: ResilienceMetricsRecorder;
  private currentState: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private successes = 0;
  private halfOpenCalls = 0;
  private lastFailure?: number;
  private openedAt = 0;

  constructor(options: DefaultCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? defaultFailureThreshold);
    this.resetTimeoutMs = Math.max(1, options.resetTimeoutMs ?? defaultResetTimeoutMs);
    this.halfOpenMaxCalls = Math.max(1, options.halfOpenMaxCalls ?? defaultHalfOpenMaxCalls);
    this.name = options.name ?? "default";
    this.now = options.now ?? Date.now;
    this.metricsRecorder = options.metricsRecorder ?? noOpResilienceMetricsRecorder;
  }

  async execute<T>(operation: () => Awaitable<T>): Promise<T> {
    const state = this.evaluateState();

    if (state === "open") {
      throw new CircuitBreakerOpenError(this.name);
    }

    if (state === "half_open") {
      this.halfOpenCalls += 1;

      if (this.halfOpenCalls > this.halfOpenMaxCalls) {
        this.halfOpenCalls -= 1;
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const value = await operation();
      this.onSuccess();
      return value;
    } catch (error) {
      if (isCancellationLikeError(error)) {
        throw error;
      }

      this.onFailure();
      throw error;
    }
  }

  state(): CircuitBreakerState {
    return this.evaluateState();
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
    this.lastFailure = undefined;
    this.openedAt = 0;
    this.transition("closed");
  }

  metrics(): CircuitBreakerMetrics {
    const state = this.evaluateState();

    return this.lastFailure === undefined
      ? { failureCount: this.consecutiveFailures, state, successCount: this.successes }
      : {
          failureCount: this.consecutiveFailures,
          lastFailureTime: this.lastFailure,
          state,
          successCount: this.successes
        };
  }

  private evaluateState(): CircuitBreakerState {
    if (this.currentState === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.transition("half_open");
      this.halfOpenCalls = 0;
    }

    return this.currentState;
  }

  private onSuccess(): void {
    if (this.currentState === "half_open") {
      this.consecutiveFailures = 0;
      this.successes += 1;
      this.halfOpenCalls = 0;
      this.transition("closed");
      return;
    }

    this.successes += 1;
    this.consecutiveFailures = 0;
  }

  private onFailure(): void {
    this.lastFailure = this.now();

    if (this.currentState === "half_open") {
      this.halfOpenCalls = 0;
      this.openedAt = this.now();
      this.transition("open");
      return;
    }

    if (this.currentState === "closed") {
      this.consecutiveFailures += 1;

      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openedAt = this.now();
        this.transition("open");
      }
    }
  }

  private transition(to: CircuitBreakerState): void {
    const from = this.currentState;

    if (from === to) {
      return;
    }

    this.currentState = to;
    this.metricsRecorder.recordCircuitBreakerStateChange?.(this.name, from, to);
  }
}

export class CircuitBreakerRegistry {
  private readonly options: Required<
    Pick<DefaultCircuitBreakerOptions, "failureThreshold" | "resetTimeoutMs" | "halfOpenMaxCalls">
  > &
    Pick<DefaultCircuitBreakerOptions, "now" | "metricsRecorder">;
  private readonly maxBreakers: number;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(options: CircuitBreakerRegistryOptions = {}) {
    this.options = {
      failureThreshold: Math.max(1, options.failureThreshold ?? defaultFailureThreshold),
      halfOpenMaxCalls: Math.max(1, options.halfOpenMaxCalls ?? defaultHalfOpenMaxCalls),
      metricsRecorder: options.metricsRecorder,
      now: options.now,
      resetTimeoutMs: Math.max(1, options.resetTimeoutMs ?? defaultResetTimeoutMs)
    };
    this.maxBreakers = Math.max(1, options.maxBreakers ?? defaultMaxBreakers);
  }

  get(name: string): CircuitBreaker {
    const existing = this.breakers.get(name);

    if (existing) {
      this.breakers.delete(name);
      this.breakers.set(name, existing);
      return existing;
    }

    const breaker = new DefaultCircuitBreaker({ ...this.options, name });
    this.breakers.set(name, breaker);
    this.evictOverflow();
    return breaker;
  }

  getIfExists(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  names(): readonly string[] {
    return [...this.breakers.keys()].sort();
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  private evictOverflow(): void {
    while (this.breakers.size > this.maxBreakers) {
      const oldest = this.breakers.keys().next().value as string | undefined;

      if (!oldest) {
        return;
      }

      this.breakers.delete(oldest);
    }
  }
}

export async function retry<T>(operation: () => Awaitable<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? defaultRetryAttempts);
  const sleep = options.sleep ?? delay;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await operation();
      options.metricsRecorder?.recordRetryAttempt?.(options.name ?? "operation", attempt, true);
      return result;
    } catch (error) {
      if (isCancellationLikeError(error)) {
        throw error;
      }

      lastError = error;
      options.metricsRecorder?.recordRetryAttempt?.(options.name ?? "operation", attempt, false);

      // A non-retryable error (4xx model-not-found / bad key, per
      // architecture.md) MUST fail fast with its own clean message.
      // Wrapping it in RetryExhaustedError("…3 attempt(s)") both
      // lies about the count and buries the root cause.
      if (options.retryable?.(error, attempt) === false) {
        throw error;
      }

      if (attempt >= maxAttempts) {
        break;
      }

      await sleep(computeRetryDelay(attempt, options));
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Awaitable<T>,
  timeoutMs: number,
  abortControllerFactory: () => AbortController = () => new AbortController()
): Promise<T> {
  // Non-finite slips past `<= 0`: setTimeout(NaN/Infinity) is
  // clamped by Node to ~1ms, so a mis-configured timeout would
  // make every call instantly TimeoutError. Treat it as
  // "no timeout" — the safe, least-surprising default.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation(abortControllerFactory().signal);
  }

  const controller = abortControllerFactory();
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class NoOpFallbackStrategy implements FallbackStrategy {
  async execute(): Promise<undefined> {
    return undefined;
  }
}

export class ModelFallbackStrategy implements FallbackStrategy {
  private readonly fallbackModels: readonly string[];
  private readonly providerRegistry?: ModelProviderRegistry;
  private readonly providers = new Map<string, ModelProvider>();
  private readonly metricsRecorder: ResilienceMetricsRecorder;

  constructor(options: ModelFallbackStrategyOptions) {
    this.fallbackModels = options.fallbackModels;
    this.providerRegistry = options.providerRegistry;
    this.metricsRecorder = options.metricsRecorder ?? noOpResilienceMetricsRecorder;

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

export function computeRetryDelay(attempt: number, options: RetryPolicy = {}): number {
  // `?? default` does NOT catch NaN / Infinity (a misconfigured
  // env-derived `Number("")` is NaN). Without this an unguarded
  // knob poisons the whole computation and the loop calls
  // `sleep(NaN)`, which `setTimeout` coerces to 0 — backoff
  // silently disabled, retries hammering a failing provider. Same
  // non-finite posture as `withTimeout`.
  const initial = Math.max(0, finiteOr(options.initialDelayMs, defaultRetryDelayMs));
  const multiplier = Math.max(1, finiteOr(options.multiplier, defaultRetryMultiplier));
  const maxDelay = Math.max(initial, finiteOr(options.maxDelayMs, Number.MAX_SAFE_INTEGER));
  const safeAttempt = Number.isFinite(attempt) ? attempt : 1;
  const base = Math.min(maxDelay, initial * multiplier ** Math.max(0, safeAttempt - 1));
  const jitterRatio = Math.max(0, Math.min(1, finiteOr(options.jitterRatio, 0)));

  if (jitterRatio === 0) {
    return base;
  }

  const rng = options.random ?? Math.random;
  const jitter = base * jitterRatio;
  // Clamp to maxDelay: jitter is applied after the cap, so an
  // unclamped result could exceed maxDelayMs by up to base*ratio
  // (≈2× with ratio 1) — maxDelayMs must stay a hard ceiling. A
  // misbehaving injected `random` can't leak a non-finite delay.
  const jittered = Math.min(maxDelay, Math.max(0, base - jitter + rng() * jitter * 2));
  return Number.isFinite(jittered) ? jittered : base;
}


export function isCancellationLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as { readonly code?: unknown; readonly name?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProviderMap(
  providers: ReadonlyMap<string, ModelProvider> | readonly ModelProvider[]
): providers is ReadonlyMap<string, ModelProvider> {
  return typeof (providers as ReadonlyMap<string, ModelProvider>).get === "function";
}
