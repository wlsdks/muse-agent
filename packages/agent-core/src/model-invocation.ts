/**
 * Model-call resilience layer extracted from AgentRuntime.
 *
 * Wraps `provider.generate` with the same defence-in-depth layers the runtime
 * has always used:
 *
 *   1. timeout (per-request `requestTimeoutMs`)
 *   2. retry policy (only when `retry.maxAttempts` is set, gated by
 *      `isRetryableProviderError`)
 *   3. fallback strategy (final-attempt rescue when the primary chain throws)
 *   4. circuit breaker (wraps the whole chain, so an open breaker short-circuits)
 *   5. tracing span (`muse.model.generate`) + AgentMetrics token-usage record
 *      + optional TokenUsageSink event
 *
 * Each layer is opt-in: when its dep is missing the wrapper degrades to the
 * raw provider.generate call, preserving the original behaviour.
 */

import { estimateCostUsd } from "@muse/cache";
import type { CircuitBreaker, FallbackStrategy, RetryOptions } from "@muse/resilience";
import { retry, scaleRequestTimeout, withTimeout } from "@muse/resilience";
import { decideWebSearchPolicy, parseModelName, USAGE_RECORDED_BY_RUNTIME_FLAG, type ModelProvider, type ModelRequest, type ModelResponse, type WebSearchPolicy, type WebSearchSettings } from "@muse/model";
import type { AgentMetrics, MuseTracer, TokenUsageSink } from "@muse/observability";
import type { JsonObject } from "@muse/shared";
import { isRetryableProviderError, recordUsageSpanAttributes } from "./runtime-helpers.js";
import { sanitiseCitations } from "./citation-sanitiser.js";

/**
 * Returns a new ModelRequest with `metadata.webSearchPolicy` populated by
 * `decideWebSearchPolicy`. Bridges runtime settings + optional per-request
 * override into the provider-facing request so provider adapters can stay
 * free of settings-layer awareness.
 */
export function buildModelRequestWithWebSearch(
  request: ModelRequest,
  ctx: {
    settings: { webSearch?: WebSearchSettings };
    override?: boolean;
    env: Readonly<Record<string, string | undefined>>;
  }
): ModelRequest {
  const parsed = parseModelName(request.model);
  const policy: WebSearchPolicy = decideWebSearchPolicy({
    model: { provider: parsed.providerId ?? "", modelId: parsed.modelId },
    settings: ctx.settings,
    override: ctx.override,
    env: ctx.env
  });
  return {
    ...request,
    metadata: { ...(request.metadata ?? {}), webSearchPolicy: { ...policy } }
  };
}

/**
 * Returns a new ModelResponse with citations filtered through sanitiseCitations.
 * Drops any citation whose URL is not http(s) (e.g. javascript:, data:).
 * No-ops when citations is absent or empty so callers don't branch.
 */
export function applyCitationSanitisation(response: ModelResponse): ModelResponse {
  if (!response.citations || response.citations.length === 0) return response;
  const { kept } = sanitiseCitations(response.citations);
  return { ...response, citations: kept };
}

export interface InvokeModelArgs {
  readonly provider: ModelProvider;
  readonly request: ModelRequest;
  readonly runId: string;
  readonly metadata?: JsonObject;
  /** Span name suffix used by callers that distinguish step types (default "act"). */
  readonly stepType?: string;
  readonly tracer: MuseTracer;
  readonly metrics: AgentMetrics;
  readonly tokenUsageSink?: TokenUsageSink;
  readonly circuitBreaker?: CircuitBreaker;
  readonly fallbackStrategy?: FallbackStrategy;
  readonly retry?: RetryOptions;
  readonly requestTimeoutMs?: number;
}

/**
 * The single resilient entry point for `provider.generate`. Composes timeout
 * → retry → fallback → circuit-breaker → tracing in that order so the outer
 * layers see the inner failures.
 */
export async function invokeModel(rawArgs: InvokeModelArgs): Promise<ModelResponse> {
  // This function records the call's usage via recordTokenUsageEvent below, so
  // flag the request: a usage-recording provider decorator skips a flagged
  // request, preventing a double-count on the non-streaming + plan-execute paths
  // (the streaming streamModelTurn flags its own request the same way).
  const args: InvokeModelArgs = {
    ...rawArgs,
    request: { ...rawArgs.request, metadata: { ...rawArgs.request.metadata, [USAGE_RECORDED_BY_RUNTIME_FLAG]: true } }
  };
  const span = args.tracer.startSpan("muse.model.generate", {
    "model.id": args.request.model,
    "provider.id": args.provider.id,
    "run.id": args.runId
  });
  try {
    const generate = () => invokeWithFallback(args);
    const raw = await (args.circuitBreaker ? args.circuitBreaker.execute(generate) : generate());
    const response = applyCitationSanitisation(raw);
    recordUsageSpanAttributes(span, response);
    if (response.usage) {
      args.metrics.recordTokenUsage(response.usage, args.metadata);
      await recordTokenUsageEvent({
        provider: args.provider,
        response,
        runId: args.runId,
        stepType: args.stepType ?? "act",
        tokenUsageSink: args.tokenUsageSink,
        tracer: args.tracer
      });
    }
    return response;
  } catch (error) {
    span.setError(error);
    throw error;
  } finally {
    span.end();
  }
}

async function invokeWithFallback(args: InvokeModelArgs): Promise<ModelResponse> {
  try {
    return await invokeWithResilience(args);
  } catch (error) {
    const fallback = await args.fallbackStrategy?.execute(
      {
        ...(args.request.maxOutputTokens !== undefined ? { maxOutputTokens: args.request.maxOutputTokens } : {}),
        messages: args.request.messages,
        ...(args.request.metadata !== undefined ? { metadata: args.request.metadata } : {}),
        ...(args.request.signal !== undefined ? { signal: args.request.signal } : {}),
        ...(args.request.temperature !== undefined ? { temperature: args.request.temperature } : {})
      },
      error
    );
    if (fallback) {
      return fallback;
    }
    throw error;
  }
}

/**
 * Rough char-based token estimate of a request — enough to scale the
 * timeout (no precision needed). Counts message content + serialized
 * tool-call args at ~4 chars/token.
 */
function estimateRequestTokens(request: ModelRequest): number {
  let chars = 0;
  for (const message of request.messages) {
    chars += message.content.length;
    for (const toolCall of message.toolCalls ?? []) {
      chars += toolCall.name.length + JSON.stringify(toolCall.arguments).length;
    }
  }
  return Math.ceil(chars / 4);
}

async function invokeWithResilience(args: InvokeModelArgs): Promise<ModelResponse> {
  const operation = () => {
    if (args.requestTimeoutMs === undefined) {
      return args.provider.generate(args.request);
    }
    // Scale the cap UP for large requests so a legitimately-slow large
    // local-model generation isn't killed prematurely; small requests
    // keep the base cap (byte-identical).
    const timeoutMs = scaleRequestTimeout(args.requestTimeoutMs, estimateRequestTokens(args.request));
    return withTimeout(() => args.provider.generate(args.request), timeoutMs);
  };
  if (!args.retry) {
    return operation();
  }
  return retry(operation, {
    ...args.retry,
    retryable: isRetryableProviderError
  });
}

export interface RecordTokenUsageEventArgs {
  readonly tokenUsageSink?: TokenUsageSink;
  readonly tracer: MuseTracer;
  readonly provider: ModelProvider;
  readonly response: ModelResponse;
  readonly runId: string;
  readonly stepType: string;
}

/**
 * Persists a single token-usage event when the response carried usage and the
 * sink is configured. Errors are swallowed to a tracer-level failure span so
 * the agent loop is never blocked by observability writes.
 */
export async function recordTokenUsageEvent(args: RecordTokenUsageEventArgs): Promise<void> {
  if (!args.tokenUsageSink) {
    return;
  }
  const usage = args.response.usage;
  if (!usage) {
    return;
  }
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  try {
    const estimatedCostUsd = estimateCostUsd(args.response.model, promptTokens, completionTokens + reasoningTokens);
    await args.tokenUsageSink.record({
      completionTokens,
      ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
      model: args.response.model,
      promptTokens,
      provider: args.provider.id,
      reasoningTokens,
      recordedAt: new Date(),
      runId: args.runId,
      stepType: args.stepType,
      totalTokens: promptTokens + completionTokens + reasoningTokens
    });
  } catch (error) {
    args.tracer
      .startSpan("muse.token_usage.record_failed", {
        error: error instanceof Error ? error.message : String(error),
        "run.id": args.runId
      })
      .end();
  }
}
