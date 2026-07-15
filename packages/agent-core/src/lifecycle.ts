/**
 * Run-lifecycle recording helpers extracted from AgentRuntime.
 *
 * Each function is fail-open: history/checkpoint/metric writes are observability
 * state and must never block agent execution. The runtime treats these as
 * side-effects only — return values are intentionally void.
 */

import { estimateCostUsd } from "@muse/cache";
import { isCancellationLikeError } from "@muse/resilience";
import type { ModelMessage } from "@muse/model";
import type { AgentRunHistoryStore, CheckpointStore } from "@muse/runtime-state";
import { createAgentCheckpointState } from "./checkpoint.js";
import { joinUserMessages } from "./internals.js";
import { metadataString, toAgentRunMode, toolCallsMetadata } from "./runtime-helpers.js";
import type { ModelLoopExecution } from "./runtime-internals.js";
import type { AgentRunContext } from "./types.js";

export interface LifecycleRunStartArgs {
  readonly historyStore?: AgentRunHistoryStore;
  readonly context: AgentRunContext;
  readonly provider: string;
  readonly model: string;
}

export async function recordRunStart(args: LifecycleRunStartArgs): Promise<void> {
  if (!args.historyStore) {
    return;
  }
  try {
    await args.historyStore.createRun({
      id: args.context.runId,
      input: joinUserMessages(args.context.input.messages),
      mode: toAgentRunMode(args.context.agentSpec?.spec.mode),
      model: args.model,
      provider: args.provider,
      startedAt: args.context.startedAt,
      status: "running",
      userId: metadataString(args.context.input.metadata, "userId")
    });

    for (const message of args.context.input.messages) {
      await args.historyStore.appendMessage({
        content: message.content,
        metadata: message.toolCalls ? toolCallsMetadata(message.toolCalls) : {},
        name: message.name,
        role: message.role,
        runId: args.context.runId,
        toolCallId: message.toolCallId
      });
    }
  } catch {
    // History is observability state and must not block agent execution.
  }
}

export interface LifecycleRunCompleteArgs {
  readonly historyStore?: AgentRunHistoryStore;
  readonly context: AgentRunContext;
  readonly execution: ModelLoopExecution;
  readonly resolveToolRisk: (name: string) => "read" | "write" | "execute";
}

export async function recordRunComplete(args: LifecycleRunCompleteArgs): Promise<void> {
  if (!args.historyStore) {
    return;
  }

  try {
    for (const message of args.execution.intermediateMessages) {
      await args.historyStore.appendMessage({
        content: message.content,
        metadata: message.toolCalls ? toolCallsMetadata(message.toolCalls) : {},
        name: message.name,
        role: message.role,
        runId: args.context.runId,
        toolCallId: message.toolCallId
      });
    }

    await args.historyStore.appendMessage({
      content: args.execution.finalResponse.output,
      metadata: args.execution.finalResponse.toolCalls
        ? toolCallsMetadata(args.execution.finalResponse.toolCalls)
        : {},
      role: "assistant",
      runId: args.context.runId
    });

    for (const executed of args.execution.toolResults) {
      await args.historyStore.recordToolCall({
        arguments: executed.toolCall.arguments,
        id: executed.toolCall.id,
        name: executed.toolCall.name,
        risk: args.resolveToolRisk(executed.toolCall.name),
        runId: args.context.runId,
        status: executed.result.status
      });
    }

    const recordedToolCallIds = new Set(args.execution.toolResults.map((executed) => executed.toolCall.id));

    for (const toolCall of args.execution.finalResponse.toolCalls ?? []) {
      if (recordedToolCallIds.has(toolCall.id)) {
        continue;
      }

      await args.historyStore.recordToolCall({
        arguments: toolCall.arguments,
        id: toolCall.id,
        name: toolCall.name,
        risk: args.resolveToolRisk(toolCall.name),
        runId: args.context.runId,
        status: "queued"
      });
    }

    const usage = args.execution.finalResponse.usage;
    const costUsd = usage
      ? estimateCostUsd(
          args.execution.finalResponse.model,
          usage.inputTokens ?? 0,
          (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0)
        )
      : 0;
    await args.historyStore.updateRun({
      completedAt: new Date(),
      ...(costUsd > 0 ? { costUsd: costUsd.toString() } : {}),
      output: args.execution.finalResponse.output,
      runId: args.context.runId,
      status: "completed",
      tokenUsage: usage ? { ...usage } : undefined
    });
  } catch {
    // History is observability state and must not block agent execution.
  }
}

export interface LifecycleCheckpointArgs {
  readonly checkpointStore?: CheckpointStore;
  readonly context: AgentRunContext;
  readonly step: number;
  readonly phase: string;
  readonly messages: readonly ModelMessage[];
  readonly output?: string;
}

export async function recordCheckpoint(args: LifecycleCheckpointArgs): Promise<void> {
  if (!args.checkpointStore) {
    return;
  }
  try {
    await args.checkpointStore.save({
      runId: args.context.runId,
      state: createAgentCheckpointState({
        metadata: args.context.input.metadata,
        model: args.context.input.model,
        ...(args.output !== undefined ? { output: args.output } : {}),
        phase: args.phase,
        messages: args.messages
      }),
      step: args.step
    });
  } catch {
    // Checkpoints support replay/debugging and must not block the agent loop.
  }
}

export interface LifecycleRunFailureArgs {
  readonly historyStore?: AgentRunHistoryStore;
  readonly context: AgentRunContext;
  readonly error: unknown;
}

export async function recordRunFailure(args: LifecycleRunFailureArgs): Promise<void> {
  if (!args.historyStore) {
    return;
  }
  try {
    await args.historyStore.updateRun({
      completedAt: new Date(),
      error: args.error instanceof Error ? args.error.message : "unknown error",
      runId: args.context.runId,
      status: isCancellationLikeError(args.error) ? "cancelled" : "failed"
    });
  } catch {
    // History is observability state and must not block agent execution.
  }
}
