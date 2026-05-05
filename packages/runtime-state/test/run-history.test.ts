import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  createAgentRunInsert,
  createAgentRunUpdate,
  createConversationMessageInsert,
  createToolCallInsert,
  createToolCallUpdate,
  InMemoryAgentRunHistoryStore,
  mapAgentRunRow,
  mapConversationMessageRow,
  mapToolCallRow
} from "../src/index.js";

describe("InMemoryAgentRunHistoryStore", () => {
  it("records run lifecycle, messages, and tool calls", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const completedAt = new Date("2026-01-01T00:00:01.000Z");
    const store = new InMemoryAgentRunHistoryStore({
      idFactory: sequentialIds(),
      now: () => now
    });

    const run = store.createRun({
      input: "Summarize this",
      model: "model-a",
      provider: "provider-a",
      userId: "user-1",
      workspaceId: "workspace-1"
    });
    const message = store.appendMessage({
      content: "Summarize this",
      role: "user",
      runId: run.id
    });
    const toolCall = store.recordToolCall({
      name: "read_file",
      risk: "read",
      runId: run.id
    });
    const completedToolCall = store.updateToolCall({
      completedAt,
      id: toolCall.id,
      result: "ok",
      status: "completed"
    });
    const completedRun = store.updateRun({
      completedAt,
      output: "Done",
      runId: run.id,
      status: "completed",
      tokenUsage: { inputTokens: 5, outputTokens: 3 }
    });

    expect(run.id).toBe("run-1");
    expect(message.id).toBe("message-2");
    expect(completedToolCall).toMatchObject({ result: "ok", status: "completed" });
    expect(completedRun).toMatchObject({
      output: "Done",
      status: "completed",
      tokenUsage: { inputTokens: 5, outputTokens: 3 }
    });
    expect(store.listRunsByUser("user-1")).toHaveLength(1);
    expect(store.listMessages(run.id).map((item) => item.content)).toEqual(["Summarize this"]);
    expect(store.listToolCalls(run.id).map((item) => item.name)).toEqual(["read_file"]);
  });

  it("returns undefined when updating unknown records", () => {
    const store = new InMemoryAgentRunHistoryStore();

    expect(store.updateRun({ runId: "missing", status: "failed" })).toBeUndefined();
    expect(store.updateToolCall({ id: "missing", status: "failed" })).toBeUndefined();
  });
});

describe("Kysely run history mapping", () => {
  it("builds PostgreSQL insert payloads for run history tables", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const options = { idFactory: sequentialIds(), now: () => now };

    const run = createAgentRunInsert(
      {
        input: "Run task",
        model: "model-a",
        provider: "provider-a",
        startedAt: now,
        status: "running",
        userId: "user-1"
      },
      options
    );
    const message = createConversationMessageInsert(
      {
        content: "Run task",
        role: "user",
        runId: run.id
      },
      options
    );
    const toolCall = createToolCallInsert(
      {
        arguments: { path: "docs/input.md" },
        name: "read_file",
        risk: "read",
        runId: run.id,
        status: "queued"
      },
      options
    );

    const runSql = db.insertInto("agent_runs").values(run).returningAll().compile();
    const messageSql = db.insertInto("conversation_messages").values(message).returningAll().compile();
    const toolSql = db.insertInto("tool_calls").values(toolCall).returningAll().compile();

    expect(runSql.sql).toContain('insert into "agent_runs"');
    expect(messageSql.sql).toContain('insert into "conversation_messages"');
    expect(toolSql.sql).toContain('insert into "tool_calls"');
    expect(run).toMatchObject({
      id: "run-1",
      input: "Run task",
      status: "running",
      user_id: "user-1"
    });
    expect(message).toMatchObject({
      content: "Run task",
      id: "message-2",
      role: "user",
      run_id: "run-1"
    });
    expect(toolCall).toMatchObject({
      arguments: { path: "docs/input.md" },
      id: "tool_call-3",
      name: "read_file",
      risk: "read"
    });
  });

  it("maps database rows back to run history records", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const run = createAgentRunInsert(
      {
        input: "Run task",
        model: "model-a",
        provider: "provider-a",
        status: "completed",
        tokenUsage: { inputTokens: 1 }
      },
      { idFactory: () => "run-1", now: () => now }
    );
    const message = createConversationMessageInsert(
      {
        content: "Done",
        metadata: { final: true },
        role: "assistant",
        runId: "run-1"
      },
      { idFactory: () => "message-1", now: () => now }
    );
    const toolCall = createToolCallInsert(
      {
        completedAt: now,
        name: "read_file",
        result: "ok",
        risk: "read",
        runId: "run-1",
        status: "completed"
      },
      { idFactory: () => "tool-1", now: () => now }
    );

    expect(mapAgentRunRow(run)).toMatchObject({
      id: "run-1",
      status: "completed",
      tokenUsage: { inputTokens: 1 }
    });
    expect(mapConversationMessageRow(message)).toMatchObject({
      content: "Done",
      metadata: { final: true },
      role: "assistant"
    });
    expect(mapToolCallRow(toolCall)).toMatchObject({
      completedAt: now,
      result: "ok",
      status: "completed"
    });
  });

  it("creates partial update payloads without resetting existing nullable fields", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(createAgentRunUpdate({ runId: "run-1", status: "completed" }, () => now)).toEqual({
      status: "completed",
      updated_at: now
    });
    expect(createToolCallUpdate({ id: "tool-1", status: "running" })).toEqual({
      status: "running"
    });
  });
});

function sequentialIds(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}-${++next}`;
}

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}
