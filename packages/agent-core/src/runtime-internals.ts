import type { ModelMessage, ModelResponse, ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import type { PlanStep, StepExecutionResult } from "./plan-execute.js";

/**
 * Internal AgentRuntime types and helpers.
 *
 * These are NOT part of the public package surface — consumers should never
 * import from this file directly. They live here so the runtime monolith does
 * not have to inline its own data shapes alongside the public AgentRuntime
 * class.
 */

export interface ExecutedToolResult {
  readonly toolCall: ModelToolCall;
  readonly result: ToolExecutionResult;
}

export interface ModelLoopExecution {
  readonly finalResponse: ModelResponse;
  readonly intermediateMessages: readonly ModelMessage[];
  readonly toolResults: readonly ExecutedToolResult[];
  readonly toolsUsed: readonly string[];
}

export interface StreamedModelTurn {
  readonly response: ModelResponse;
}

export interface StreamExecutionOptions {
  readonly forwardTextDeltas: boolean;
}

export interface PlanExecuteStepRecord {
  readonly step: PlanStep;
  readonly executed: ExecutedToolResult;
  readonly stepResult: StepExecutionResult;
}

/**
 * Builds the synthetic `ExecutedToolResult` we hand back when a tool call is
 * rejected before reaching the executor (max-tool-call cap, unexposed tool,
 * missing executor, blocked validation, etc.). The synthesised result keeps
 * the ToolCall id/name pair so the runtime's history sink and message-pair
 * integrity checks see a consistent shape.
 */
export function blockedToolResult(toolCall: ModelToolCall, output: string): ExecutedToolResult {
  return {
    result: {
      id: toolCall.id,
      name: toolCall.name,
      output,
      status: "blocked"
    },
    toolCall
  };
}

/**
 * Renders the executed Plan-Execute steps as the assistant + tool message
 * pair the synthesis-time prompt expects. The assistant message carries the
 * raw plan JSON plus every tool call (so the message pair is intact); each
 * tool message carries its result keyed by the assistant's tool call id.
 */
export function planExecuteIntermediateMessages(
  plan: readonly PlanStep[],
  executed: readonly PlanExecuteStepRecord[]
): readonly ModelMessage[] {
  const planSummary: ModelMessage = {
    content: JSON.stringify(plan),
    role: "assistant",
    toolCalls: executed.map((entry) => entry.executed.toolCall)
  };
  const toolMessages: ModelMessage[] = executed.map((entry) => ({
    content: entry.executed.result.output,
    name: entry.executed.toolCall.name,
    role: "tool",
    toolCallId: entry.executed.toolCall.id
  }));
  return [planSummary, ...toolMessages];
}
