/**
 * Model-request preparation lifted out of `AgentRuntime`. It needed exactly
 * one piece of instance state — the configured `ConversationTrimOptions` —
 * so it takes that as its first parameter instead of reading `this`.
 * Keeping it here means the trim/compaction decision is readable without
 * the 1,500-line runtime around it.
 */

import {
  awaitModelContextWindow,
  isModelContextWindowCancelledError,
  ModelContextBudgetError,
  type ModelContextWindowResolution,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest
} from "@muse/model";
import {
  estimateModelRequestTokens,
  estimateModelToolsTokens,
  ModelRequestEstimateError,
  trimConversationMessages,
  type ConversationTrimOptions
} from "@muse/memory";

import type { ActiveContextSnapshot } from "./active-context.js";
import type { AgentContextWindowReport, AgentRunInput } from "./types.js";

function outputReserve(request: ModelRequest, options: ConversationTrimOptions): number {
  const requested = request.maxOutputTokens;
  return typeof requested === "number" && Number.isSafeInteger(requested) && requested >= 1 && requested <= 131_072
    ? requested
    : options.outputReserveTokens;
}

function validProviderWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 256 && value <= 2_000_000;
}

export async function resolveModelAwareTrimOptions(
  contextWindowOptions: ConversationTrimOptions | undefined,
  provider: ModelProvider,
  request: Pick<ModelRequest, "maxOutputTokens" | "model" | "responseFormat" | "signal" | "tools">
): Promise<ConversationTrimOptions | undefined> {
  if (!contextWindowOptions || contextWindowOptions.maxContextWindowTokens < 256) return contextWindowOptions;
  let resolution: ModelContextWindowResolution | undefined;
  try {
    resolution = await awaitModelContextWindow(provider, request.model, request.signal);
  } catch (error) {
    if (isModelContextWindowCancelledError(error)) throw error;
    throw new ModelContextBudgetError(provider.id, "STATE_UNAVAILABLE");
  }
  try {
    if (resolution && !validProviderWindow(resolution.providerWindowTokens)) throw new ModelRequestEstimateError();
    const admissionWindowTokens = Math.min(
      contextWindowOptions.maxContextWindowTokens,
      resolution?.providerWindowTokens ?? contextWindowOptions.maxContextWindowTokens
    );
    const outputReserveTokens = outputReserve({ messages: [], ...request }, contextWindowOptions);
    const toolAndFormatReserve = estimateModelToolsTokens(request.tools)
      + (request.responseFormat === undefined
        ? 0
        : estimateModelRequestTokens({ messages: [], responseFormat: request.responseFormat }).responseFormatTokens);
    if (outputReserveTokens + toolAndFormatReserve >= admissionWindowTokens) {
      throw new ModelContextBudgetError(provider.id, "CONTEXT_BUDGET_EXCEEDED");
    }
    return {
      ...contextWindowOptions,
      maxContextWindowTokens: admissionWindowTokens,
      outputReserveTokens,
      toolTokenReserve: toolAndFormatReserve,
      ...(contextWindowOptions.workingBudgetTokens !== undefined
        ? { workingBudgetTokens: Math.min(contextWindowOptions.workingBudgetTokens, admissionWindowTokens) }
        : {})
    };
  } catch (error) {
    if (error instanceof ModelContextBudgetError) throw error;
    throw new ModelContextBudgetError(provider.id, "STATE_UNAVAILABLE");
  }
}

/** Apply the same model-aware message budget immediately before a physical turn. */
export async function prepareContextAdmittedRequest(
  contextWindowOptions: ConversationTrimOptions | undefined,
  provider: ModelProvider,
  request: ModelRequest
): Promise<ModelRequest> {
  if (!contextWindowOptions) return request;
  // Direct unit/custom runtimes historically use tiny synthetic windows to
  // exercise the legacy trim passes. Production config never resolves below
  // 4K; leave those synthetic contracts to prepareModelRequest.
  if (contextWindowOptions.maxContextWindowTokens < 256) return request;
  try {
    const resolvedOptions = await resolveModelAwareTrimOptions(contextWindowOptions, provider, request);
    if (!resolvedOptions) return request;
    const trimmed = trimConversationMessages(request.messages, {
      ...resolvedOptions,
      preserveLatestToolExchange: true
    });
    const prepared = { ...request, messages: trimmed.messages };
    const estimate = estimateModelRequestTokens(prepared);
    if (estimate.estimatedInputTokens + resolvedOptions.outputReserveTokens > resolvedOptions.maxContextWindowTokens) {
      throw new ModelContextBudgetError(provider.id, "CONTEXT_BUDGET_EXCEEDED");
    }
    return prepared;
  } catch (error) {
    if (error instanceof ModelContextBudgetError || isModelContextWindowCancelledError(error)) {
      throw error;
    }
    throw new ModelContextBudgetError(provider.id, "STATE_UNAVAILABLE");
  }
}

export function prepareModelRequest(
  contextWindowOptions: ConversationTrimOptions | undefined,
  input: AgentRunInput,
  model: string,
  personaSnapshot?: string,
  activeContextSnapshot?: ActiveContextSnapshot
): {
  readonly contextWindow?: AgentContextWindowReport;
  readonly dropped?: readonly ModelMessage[];
  readonly request: Pick<ModelRequest, "messages" | "metadata" | "model">;
} {
  if (!contextWindowOptions) {
    return {
      request: {
        messages: input.messages,
        metadata: input.metadata,
        model
      }
    };
  }

  // Merge the resolved persona snapshot into the trim options so
  // it becomes part of the compaction summary's `[User context: ...]`
  // block when the trim fires. When unset
  // (no provider / no userId / empty memory), trim sees `undefined`
  // and behaves identically to before.
  // Also pipe the active task / focus from the
  // active-context snapshot into `importanceContext` so
  // `scoreMessageImportance` boosts messages that mention the
  // user's current work — otherwise the scorer only sees the
  // hard-coded decision hints.
  const importanceContext = activeContextSnapshot
    ? {
        ...(activeContextSnapshot.activeTask?.id ? { activeTaskId: activeContextSnapshot.activeTask.id } : {}),
        ...(activeContextSnapshot.activeTask?.title ? { activeTaskTitle: activeContextSnapshot.activeTask.title } : {}),
        ...(activeContextSnapshot.currentFocus ? { currentFocus: activeContextSnapshot.currentFocus } : {})
      }
    : undefined;
  const hasImportance = importanceContext && Object.keys(importanceContext).length > 0;
  const trimOptions: ConversationTrimOptions = {
    ...contextWindowOptions,
    ...(personaSnapshot ? { personaSnapshot } : {}),
    ...(hasImportance ? { importanceContext } : {})
  };
  const trimResult = trimConversationMessages(input.messages, trimOptions);

  return {
    contextWindow: {
      budgetTokens: trimResult.budgetTokens,
      estimatedTokens: trimResult.estimatedTokens,
      removedCount: trimResult.removedCount,
      summaryInserted: trimResult.summaryInserted,
      triggeredBy: trimResult.triggeredBy
    },
    dropped: trimResult.dropped,
    request: {
      messages: trimResult.messages,
      metadata: input.metadata,
      model
    }
  };
}

/**
 * Execute a parsed PTC {@link ToolPlan} where EVERY step runs through the SAME gated single-tool
 * path as a native tool call ({@link executeToolCall}: beforeTool hook → approval gate → arg
 * coercion/required/enum validation → arg grounding → executor → afterTool hook). It does not
 * bypass or re-implement a single gate — it binds the plan interpreter's pluggable executor seam
 * ({@link executeToolPlan}) to that method. A step whose gated call does not COMPLETE (denied,
 * invalid, or failed) throws {@link ToolPlanStepBlockedError}, which aborts the plan before any
 * later step runs, so a blocked step leaves no partial downstream effect. A 1-step plan is
 * therefore gate-equivalent to a single native tool call. Phase 2 scope is gated EXECUTION only;
 * grounding/citation of the plan's projected result is Phase 3.
 */
