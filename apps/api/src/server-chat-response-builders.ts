import type { AgentRunResult } from "@muse/agent-core";
import type { GatedChatAnswer } from "@muse/recall";
import type { AgentRunRecord } from "@muse/runtime-state";
import type { JsonObject } from "@muse/shared";

/**
 * The deterministic grounding gate's verdict for the chat answer (see
 * `gateChatAnswerGrounding`). Surfaced on every chat response so the API chat
 * surface reports its grounding work the way `/api/ask` does: the verdict plus the
 * citations the gate stripped as fabricated.
 */
export type ChatGroundingReport = Pick<GatedChatAnswer, "groundingVerdict" | "strippedCitations">;

export function toCompatChatResponse(result: AgentRunResult, grounding?: ChatGroundingReport) {
  const tokenUsage = compatTokenUsage(result.response.usage);
  const metadata = compatResponseMetadata(result);

  return {
    blockReason: typeof metadata.blockReason === "string" ? metadata.blockReason : null,
    citations: result.response.citations ?? [],
    content: result.response.output,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    grounded: typeof metadata.grounded === "boolean" ? metadata.grounded : null,
    groundingVerdict: grounding?.groundingVerdict ?? null,
    metadata,
    model: result.response.model,
    strippedCitations: grounding ? [...grounding.strippedCitations] : [],
    success: true,
    tokenUsage,
    toolsUsed: result.toolsUsed ?? [],
    verifiedSourceCount: typeof metadata.verifiedSourceCount === "number" ? metadata.verifiedSourceCount : null
  };
}

export function toAdminRunSummary(run: AgentRunRecord) {
  return {
    id: run.id,
    inputPreview: previewText(run.input, 120),
    model: run.model,
    provider: run.provider,
    status: run.status
  };
}

function previewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function toExtendedChatResponse(result: AgentRunResult, grounding?: ChatGroundingReport) {
  return {
    ...toCompatChatResponse(result, grounding),
    agentSpec: result.agentSpec,
    contextWindow: result.contextWindow,
    fromCache: result.fromCache ?? false,
    response: result.response.output,
    runId: result.runId,
    usage: result.response.usage
  };
}

function compatTokenUsage(usage: AgentRunResult["response"]["usage"]) {
  if (!usage) {
    return null;
  }

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    cachedContentTokens: usage.cachedInputTokens ?? null,
    completionTokens,
    promptTokens,
    thoughtsTokens: usage.reasoningTokens ?? null,
    toolUsePromptTokens: null,
    totalTokens: promptTokens + completionTokens,
    trafficType: null
  };
}

function compatResponseMetadata(result: AgentRunResult): JsonObject {
  return {
    ...(result.agentSpec
      ? {
        agentSpec: {
          confidence: result.agentSpec.confidence,
          matchedKeywords: [...result.agentSpec.matchedKeywords],
          name: result.agentSpec.name,
          toolNames: [...result.agentSpec.toolNames]
        }
      }
      : {}),
    ...(result.contextWindow
      ? {
        contextWindow: {
          budgetTokens: result.contextWindow.budgetTokens,
          estimatedTokens: result.contextWindow.estimatedTokens,
          removedCount: result.contextWindow.removedCount,
          summaryInserted: result.contextWindow.summaryInserted
        }
      }
      : {}),
    fromCache: result.fromCache ?? false,
    runId: result.runId
  };
}
