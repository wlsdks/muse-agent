/**
 * Model-request preparation lifted out of `AgentRuntime`. It needed exactly
 * one piece of instance state — the configured `ConversationTrimOptions` —
 * so it takes that as its first parameter instead of reading `this`.
 * Keeping it here means the trim/compaction decision is readable without
 * the 1,500-line runtime around it.
 */

import type { ModelMessage, ModelRequest } from "@muse/model";
import { trimConversationMessages, type ConversationTrimOptions } from "@muse/memory";

import type { ActiveContextSnapshot } from "./active-context.js";
import type { AgentContextWindowReport, AgentRunInput } from "./types.js";

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