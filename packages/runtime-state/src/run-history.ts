import type { AgentRunTable, ConversationMessageTable, MuseDatabase, ToolCallTable } from "@muse/db";
import { createRunId, type JsonObject, type RunStatus } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import type { Awaitable } from "./index.js";

export type AgentRunMode = "react" | "standard" | "plan_execute";
export type ToolCallRisk = "read" | "write" | "execute";
export type ToolCallStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export type ConversationRole = "system" | "user" | "assistant" | "tool";

export interface AgentRunRecord {
  readonly id: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly status: RunStatus;
  readonly provider: string;
  readonly model: string;
  readonly mode: AgentRunMode;
  readonly input: string;
  readonly output?: string;
  readonly error?: string;
  readonly tokenUsage: JsonObject;
  readonly costUsd: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConversationMessageRecord {
  readonly id: string;
  readonly runId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
}

export interface ToolCallRecord {
  readonly id: string;
  readonly runId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly risk: ToolCallRisk;
  readonly status: ToolCallStatus;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
}

export interface CreateAgentRunInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly status?: RunStatus;
  readonly provider: string;
  readonly model: string;
  readonly mode?: AgentRunMode;
  readonly input: string;
  readonly tokenUsage?: JsonObject;
  readonly costUsd?: string;
  readonly startedAt?: Date;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface UpdateAgentRunInput {
  readonly runId: string;
  readonly status: RunStatus;
  readonly output?: string;
  readonly error?: string;
  readonly tokenUsage?: JsonObject;
  readonly costUsd?: string;
  readonly completedAt?: Date;
  readonly updatedAt?: Date;
}

export interface AppendConversationMessageInput {
  readonly id?: string;
  readonly runId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly metadata?: JsonObject;
  readonly createdAt?: Date;
}

export interface RecordToolCallInput {
  readonly id?: string;
  readonly runId: string;
  readonly name: string;
  readonly arguments?: JsonObject;
  readonly risk: ToolCallRisk;
  readonly status?: ToolCallStatus;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt?: Date;
}

export interface UpdateToolCallInput {
  readonly id: string;
  readonly status: ToolCallStatus;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
}

export interface AgentRunHistoryStore {
  createRun(input: CreateAgentRunInput): Awaitable<AgentRunRecord>;
  updateRun(input: UpdateAgentRunInput): Awaitable<AgentRunRecord | undefined>;
  findRun(runId: string): Awaitable<AgentRunRecord | undefined>;
  listRunsByUser(userId: string): Awaitable<readonly AgentRunRecord[]>;
  appendMessage(input: AppendConversationMessageInput): Awaitable<ConversationMessageRecord>;
  listMessages(runId: string): Awaitable<readonly ConversationMessageRecord[]>;
  recordToolCall(input: RecordToolCallInput): Awaitable<ToolCallRecord>;
  updateToolCall(input: UpdateToolCallInput): Awaitable<ToolCallRecord | undefined>;
  listToolCalls(runId: string): Awaitable<readonly ToolCallRecord[]>;
}

export interface InMemoryAgentRunHistoryStoreOptions {
  readonly idFactory?: (prefix: string) => string;
  readonly now?: () => Date;
}

export interface KyselyAgentRunHistoryStoreOptions {
  readonly idFactory?: (prefix: string) => string;
  readonly now?: () => Date;
}

type AgentRunRow = Selectable<AgentRunTable>;
type ConversationMessageRow = Selectable<ConversationMessageTable>;
type ToolCallRow = Selectable<ToolCallTable>;
type AgentRunInsert = Insertable<AgentRunTable>;
type ConversationMessageInsert = Insertable<ConversationMessageTable>;
type ToolCallInsert = Insertable<ToolCallTable>;

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

export class KyselyAgentRunHistoryStore implements AgentRunHistoryStore {
  private readonly idFactory: (prefix: string) => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyAgentRunHistoryStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? createRunId;
    this.now = options.now ?? (() => new Date());
  }

  async createRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    const row = await this.db
      .insertInto("agent_runs")
      .values(createAgentRunInsert(input, { idFactory: this.idFactory, now: this.now }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapAgentRunRow(row);
  }

  async updateRun(input: UpdateAgentRunInput): Promise<AgentRunRecord | undefined> {
    const row = await this.db
      .updateTable("agent_runs")
      .set(createAgentRunUpdate(input, this.now))
      .where("id", "=", input.runId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapAgentRunRow(row) : undefined;
  }

  async findRun(runId: string): Promise<AgentRunRecord | undefined> {
    const row = await this.db.selectFrom("agent_runs").selectAll().where("id", "=", runId).executeTakeFirst();

    return row ? mapAgentRunRow(row) : undefined;
  }

  async listRunsByUser(userId: string): Promise<readonly AgentRunRecord[]> {
    const rows = await this.db
      .selectFrom("agent_runs")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map(mapAgentRunRow);
  }

  async appendMessage(input: AppendConversationMessageInput): Promise<ConversationMessageRecord> {
    const row = await this.db
      .insertInto("conversation_messages")
      .values(createConversationMessageInsert(input, { idFactory: this.idFactory, now: this.now }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapConversationMessageRow(row);
  }

  async listMessages(runId: string): Promise<readonly ConversationMessageRecord[]> {
    const rows = await this.db
      .selectFrom("conversation_messages")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(mapConversationMessageRow);
  }

  async recordToolCall(input: RecordToolCallInput): Promise<ToolCallRecord> {
    const row = await this.db
      .insertInto("tool_calls")
      .values(createToolCallInsert(input, { idFactory: this.idFactory, now: this.now }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapToolCallRow(row);
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<ToolCallRecord | undefined> {
    const row = await this.db
      .updateTable("tool_calls")
      .set(createToolCallUpdate(input))
      .where("id", "=", input.id)
      .returningAll()
      .executeTakeFirst();

    return row ? mapToolCallRow(row) : undefined;
  }

  async listToolCalls(runId: string): Promise<readonly ToolCallRecord[]> {
    const rows = await this.db
      .selectFrom("tool_calls")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(mapToolCallRow);
  }
}

export function createAgentRunRecord(
  input: CreateAgentRunInput,
  options: Required<InMemoryAgentRunHistoryStoreOptions>
): AgentRunRecord {
  const createdAt = input.createdAt ?? options.now();

  return {
    completedAt: undefined,
    costUsd: input.costUsd ?? "0",
    createdAt,
    error: undefined,
    id: input.id ?? options.idFactory("run"),
    input: input.input,
    mode: input.mode ?? "react",
    model: input.model,
    output: undefined,
    provider: input.provider,
    startedAt: input.startedAt,
    status: input.status ?? "queued",
    tokenUsage: input.tokenUsage ?? {},
    updatedAt: input.updatedAt ?? createdAt,
    userId: input.userId,
    workspaceId: input.workspaceId
  };
}

export function createConversationMessageRecord(
  input: AppendConversationMessageInput,
  options: Required<InMemoryAgentRunHistoryStoreOptions>
): ConversationMessageRecord {
  return {
    content: input.content,
    createdAt: input.createdAt ?? options.now(),
    id: input.id ?? options.idFactory("message"),
    metadata: input.metadata ?? {},
    name: input.name,
    role: input.role,
    runId: input.runId,
    toolCallId: input.toolCallId
  };
}

export function createToolCallRecord(
  input: RecordToolCallInput,
  options: Required<InMemoryAgentRunHistoryStoreOptions>
): ToolCallRecord {
  return {
    arguments: input.arguments ?? {},
    completedAt: input.completedAt,
    createdAt: input.createdAt ?? options.now(),
    error: input.error,
    id: input.id ?? options.idFactory("tool_call"),
    name: input.name,
    result: input.result,
    risk: input.risk,
    runId: input.runId,
    startedAt: input.startedAt,
    status: input.status ?? "queued"
  };
}

export function createAgentRunInsert(
  input: CreateAgentRunInput,
  options: Required<KyselyAgentRunHistoryStoreOptions>
): AgentRunInsert {
  const record = createAgentRunRecord(input, options);

  return {
    completed_at: record.completedAt ?? null,
    cost_usd: record.costUsd,
    created_at: record.createdAt,
    error: record.error ?? null,
    id: record.id,
    input: record.input,
    mode: record.mode,
    model: record.model,
    output: record.output ?? null,
    provider: record.provider,
    started_at: record.startedAt ?? null,
    status: record.status,
    token_usage: record.tokenUsage,
    updated_at: record.updatedAt,
    user_id: record.userId ?? null,
    workspace_id: record.workspaceId ?? null
  };
}

export function createConversationMessageInsert(
  input: AppendConversationMessageInput,
  options: Required<KyselyAgentRunHistoryStoreOptions>
): ConversationMessageInsert {
  const record = createConversationMessageRecord(input, options);

  return {
    content: record.content,
    created_at: record.createdAt,
    id: record.id,
    metadata: record.metadata,
    name: record.name ?? null,
    role: record.role,
    run_id: record.runId,
    tool_call_id: record.toolCallId ?? null
  };
}

export function createToolCallInsert(
  input: RecordToolCallInput,
  options: Required<KyselyAgentRunHistoryStoreOptions>
): ToolCallInsert {
  const record = createToolCallRecord(input, options);

  return {
    arguments: record.arguments,
    completed_at: record.completedAt ?? null,
    created_at: record.createdAt,
    error: record.error ?? null,
    id: record.id,
    name: record.name,
    result: record.result ?? null,
    risk: record.risk,
    run_id: record.runId,
    started_at: record.startedAt ?? null,
    status: record.status
  };
}

export function createAgentRunUpdate(input: UpdateAgentRunInput, now: () => Date) {
  return {
    ...(input.completedAt !== undefined ? { completed_at: input.completedAt } : {}),
    ...(input.costUsd !== undefined ? { cost_usd: input.costUsd } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.tokenUsage !== undefined ? { token_usage: input.tokenUsage } : {}),
    status: input.status,
    updated_at: input.updatedAt ?? now()
  };
}

export function createToolCallUpdate(input: UpdateToolCallInput) {
  return {
    ...(input.completedAt !== undefined ? { completed_at: input.completedAt } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.startedAt !== undefined ? { started_at: input.startedAt } : {}),
    status: input.status
  };
}

export function mapAgentRunRow(row: AgentRunRow): AgentRunRecord {
  return {
    completedAt: row.completed_at ? toDate(row.completed_at) : undefined,
    costUsd: row.cost_usd,
    createdAt: toDate(row.created_at),
    error: row.error ?? undefined,
    id: row.id,
    input: row.input,
    mode: row.mode as AgentRunMode,
    model: row.model,
    output: row.output ?? undefined,
    provider: row.provider,
    startedAt: row.started_at ? toDate(row.started_at) : undefined,
    status: row.status,
    tokenUsage: toJsonObject(row.token_usage),
    updatedAt: toDate(row.updated_at),
    userId: row.user_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined
  };
}

export function mapConversationMessageRow(row: ConversationMessageRow): ConversationMessageRecord {
  return {
    content: row.content,
    createdAt: toDate(row.created_at),
    id: row.id,
    metadata: toJsonObject(row.metadata),
    name: row.name ?? undefined,
    role: row.role,
    runId: row.run_id,
    toolCallId: row.tool_call_id ?? undefined
  };
}

export function mapToolCallRow(row: ToolCallRow): ToolCallRecord {
  return {
    arguments: toJsonObject(row.arguments),
    completedAt: row.completed_at ? toDate(row.completed_at) : undefined,
    createdAt: toDate(row.created_at),
    error: row.error ?? undefined,
    id: row.id,
    name: row.name,
    result: row.result ?? undefined,
    risk: row.risk,
    runId: row.run_id,
    startedAt: row.started_at ? toDate(row.started_at) : undefined,
    status: row.status
  };
}

function compareRunsNewestFirst(left: AgentRunRecord, right: AgentRunRecord): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}

function compareMessages(left: ConversationMessageRecord, right: ConversationMessageRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

function compareToolCalls(left: ToolCallRecord, right: ToolCallRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
