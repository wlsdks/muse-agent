// The Kysely-backed AgentRunHistoryStore implementation, split out of
// run-history.ts (barrel cleanup) — the record/insert/mapper shapes and the
// insert/update/mapper helpers both store implementations share stay in
// run-history.ts, which this file depends on (one direction only).
import type { MuseDatabase } from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Kysely } from "kysely";

import {
  createAgentRunInsert,
  createAgentRunUpdate,
  createConversationMessageInsert,
  createToolCallInsert,
  createToolCallUpdate,
  mapAgentRunRow,
  mapConversationMessageRow,
  mapToolCallRow,
  type AgentRunHistoryStore,
  type AgentRunRecord,
  type AppendConversationMessageInput,
  type ConversationMessageRecord,
  type CreateAgentRunInput,
  type KyselyAgentRunHistoryStoreOptions,
  type ListAgentRunsOptions,
  type RecordToolCallInput,
  type ToolCallRecord,
  type UpdateAgentRunInput,
  type UpdateToolCallInput
} from "./run-history.js";

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

  async deleteRun(runId: string): Promise<boolean> {
    const result = await this.db.deleteFrom("agent_runs").where("id", "=", runId).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async listRuns(options: ListAgentRunsOptions = {}): Promise<readonly AgentRunRecord[]> {
    let query = this.db
      .selectFrom("agent_runs")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "asc");

    if (options.limit !== undefined) {
      query = query.limit(Math.max(0, options.limit));
    }

    if (options.offset !== undefined) {
      query = query.offset(Math.max(0, options.offset));
    }

    const rows = await query.execute();
    return rows.map(mapAgentRunRow);
  }

  async listRunsByUser(userId: string): Promise<readonly AgentRunRecord[]> {
    const rows = await this.db
      .selectFrom("agent_runs")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
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
      .orderBy("id", "asc")
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
      .orderBy("id", "asc")
      .execute();

    return rows.map(mapToolCallRow);
  }
}
