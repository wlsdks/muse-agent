// The in-process AgentRunHistoryStore implementation, split out of
// run-history.ts (barrel cleanup) — the record/insert/mapper shapes and the
// factory + comparator helpers both store implementations share stay in
// run-history.ts, which this file depends on (one direction only).
import { createRunId } from "@muse/shared";

import {
  compareMessages,
  compareRunsNewestFirst,
  compareToolCalls,
  createAgentRunRecord,
  createConversationMessageRecord,
  createToolCallRecord,
  type AgentRunHistoryStore,
  type AgentRunRecord,
  type AppendConversationMessageInput,
  type ConversationMessageRecord,
  type CreateAgentRunInput,
  type InMemoryAgentRunHistoryStoreOptions,
  type ListAgentRunsOptions,
  type RecordToolCallInput,
  type ToolCallRecord,
  type UpdateAgentRunInput,
  type UpdateToolCallInput
} from "./run-history.js";

export class InMemoryAgentRunHistoryStore implements AgentRunHistoryStore {
  private readonly idFactory: (prefix: string) => string;
  private readonly now: () => Date;
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly messagesByRunId = new Map<string, ConversationMessageRecord[]>();
  private readonly toolCallsByRunId = new Map<string, ToolCallRecord[]>();

  constructor(options: InMemoryAgentRunHistoryStoreOptions = {}) {
    this.idFactory = options.idFactory ?? createRunId;
    this.now = options.now ?? (() => new Date());
  }

  createRun(input: CreateAgentRunInput): AgentRunRecord {
    const run = createAgentRunRecord(input, {
      idFactory: this.idFactory,
      now: this.now
    });

    this.runs.set(run.id, run);
    return run;
  }

  updateRun(input: UpdateAgentRunInput): AgentRunRecord | undefined {
    const existing = this.runs.get(input.runId);

    if (!existing) {
      return undefined;
    }

    const updated = {
      ...existing,
      completedAt: input.completedAt ?? existing.completedAt,
      costUsd: input.costUsd ?? existing.costUsd,
      error: input.error ?? existing.error,
      output: input.output ?? existing.output,
      status: input.status,
      tokenUsage: input.tokenUsage ?? existing.tokenUsage,
      updatedAt: input.updatedAt ?? this.now()
    };

    this.runs.set(updated.id, updated);
    return updated;
  }

  findRun(runId: string): AgentRunRecord | undefined {
    return this.runs.get(runId);
  }

  deleteRun(runId: string): boolean {
    const deleted = this.runs.delete(runId);

    if (deleted) {
      this.messagesByRunId.delete(runId);
      this.toolCallsByRunId.delete(runId);
    }

    return deleted;
  }

  listRuns(options: ListAgentRunsOptions = {}): readonly AgentRunRecord[] {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(0, options.limit ?? this.runs.size);
    return [...this.runs.values()]
      .sort(compareRunsNewestFirst)
      .slice(offset, offset + limit);
  }

  listRunsByUser(userId: string): readonly AgentRunRecord[] {
    return [...this.runs.values()]
      .filter((run) => run.userId === userId)
      .sort(compareRunsNewestFirst);
  }

  appendMessage(input: AppendConversationMessageInput): ConversationMessageRecord {
    const message = createConversationMessageRecord(input, {
      idFactory: this.idFactory,
      now: this.now
    });
    const messages = this.messagesByRunId.get(message.runId) ?? [];

    messages.push(message);
    messages.sort(compareMessages);
    this.messagesByRunId.set(message.runId, messages);
    return message;
  }

  listMessages(runId: string): readonly ConversationMessageRecord[] {
    return [...(this.messagesByRunId.get(runId) ?? [])].sort(compareMessages);
  }

  recordToolCall(input: RecordToolCallInput): ToolCallRecord {
    const toolCall = createToolCallRecord(input, {
      idFactory: this.idFactory,
      now: this.now
    });
    const toolCalls = this.toolCallsByRunId.get(toolCall.runId) ?? [];
    const index = toolCalls.findIndex((item) => item.id === toolCall.id);

    if (index >= 0) {
      toolCalls[index] = toolCall;
    } else {
      toolCalls.push(toolCall);
    }

    toolCalls.sort(compareToolCalls);
    this.toolCallsByRunId.set(toolCall.runId, toolCalls);
    return toolCall;
  }

  updateToolCall(input: UpdateToolCallInput): ToolCallRecord | undefined {
    for (const [runId, toolCalls] of this.toolCallsByRunId.entries()) {
      const index = toolCalls.findIndex((item) => item.id === input.id);

      if (index < 0) {
        continue;
      }

      const existing = toolCalls[index];

      if (!existing) {
        return undefined;
      }

      const updated = {
        ...existing,
        completedAt: input.completedAt ?? existing.completedAt,
        error: input.error ?? existing.error,
        result: input.result ?? existing.result,
        startedAt: input.startedAt ?? existing.startedAt,
        status: input.status
      };

      toolCalls[index] = updated;
      this.toolCallsByRunId.set(runId, toolCalls);
      return updated;
    }

    return undefined;
  }

  listToolCalls(runId: string): readonly ToolCallRecord[] {
    return [...(this.toolCallsByRunId.get(runId) ?? [])].sort(compareToolCalls);
  }
}
