/**
 * A ModelProvider decorator that records token usage to a TokenUsageSink on EVERY
 * generate / stream completion. It exists because the local answer path calls
 * `provider.generate/stream` DIRECTLY — bypassing the runtime's model-loop, the
 * only place that called `recordTokenUsageEvent` — so the local-first product
 * captured ZERO usage. Wrapping the provider once makes every call point record.
 *
 * Dedup with the runtime: model-loop already records its own calls via
 * `recordTokenUsageEvent`, and flags those requests with `usageRecordedByRuntime:
 * true` in metadata. This decorator SKIPS a flagged request so a tool-using turn
 * is counted once, not twice. Best-effort: a sink write never breaks a turn.
 */

import { USAGE_RECORDED_BY_RUNTIME_FLAG, type ModelEvent, type ModelProvider, type ModelRequest, type ModelResponse } from "@muse/model";
import type { TokenUsageRecord, TokenUsageSink } from "@muse/observability";

function readRunId(request: ModelRequest): string {
  const meta = request.metadata;
  const runId = meta && typeof meta.runId === "string" ? meta.runId : undefined;
  return runId && runId.trim().length > 0 ? runId : "cli.local";
}

function alreadyRecorded(request: ModelRequest): boolean {
  return request.metadata?.[USAGE_RECORDED_BY_RUNTIME_FLAG] === true;
}

function toRecord(response: ModelResponse, providerId: string, runId: string): TokenUsageRecord | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  return {
    completionTokens,
    estimatedCostUsd: 0, // local Ollama is $0; a cloud rate-card is the server path's job
    model: response.model,
    promptTokens,
    provider: providerId,
    reasoningTokens,
    runId,
    stepType: "answer",
    totalTokens: promptTokens + completionTokens + reasoningTokens,
    ...(usage.cachedInputTokens !== undefined ? { promptCachedTokens: usage.cachedInputTokens } : {}),
    recordedAt: new Date()
  };
}

export function createUsageRecordingProvider(provider: ModelProvider, sink: TokenUsageSink): ModelProvider {
  const record = async (response: ModelResponse, request: ModelRequest): Promise<void> => {
    if (alreadyRecorded(request)) return;
    const rec = toRecord(response, provider.id, readRunId(request));
    if (!rec) return;
    try {
      await sink.record(rec);
    } catch {
      /* usage telemetry is best-effort — never break a turn on a sink write */
    }
  };
  return {
    id: provider.id,
    listModels: () => provider.listModels(),
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await provider.generate(request);
      await record(response, request);
      return response;
    },
    stream: (request: ModelRequest): AsyncIterable<ModelEvent> => {
      async function* recordingStream(): AsyncIterable<ModelEvent> {
        for await (const event of provider.stream(request)) {
          if (event.type === "done") await record(event.response, request);
          yield event;
        }
      }
      return recordingStream();
    },
    ...(provider.resolveContextWindow
      ? { resolveContextWindow: (model: string) => provider.resolveContextWindow!(model) }
      : {})
  };
}
