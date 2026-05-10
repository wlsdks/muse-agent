import { describe, expect, it } from "vitest";
import { migrationNames, migrations } from "../src/index.js";

describe("db migrations", () => {
  it("keeps migration names stable and sorted", () => {
    expect(migrationNames()).toEqual(["0001_runtime_state"]);
  });

  it("creates core runtime state tables", () => {
    const sql = migrations.map((migration) => migration.up).join("\n");

    for (const table of [
      "agent_runs",
      "users",
      "conversation_messages",
      "tool_calls",
      "checkpoints",
      "trace_events",
      "hook_traces",
      "runtime_settings",
      "agent_specs",
      "mcp_servers",
      "mcp_security_policy",
      "scheduled_jobs",
      "scheduled_job_executions",
      "scheduled_job_locks"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("does not include private migration material", () => {
    const sql = migrations.map((migration) => migration.up).join("\n");

    expect(sql).not.toMatch(/\/Users\//);
    expect(sql).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(sql).not.toMatch(/\b(?:sk-|ghp_|xox[baprs]-)/);
  });

  it("covers the persistent table names the runtime relies on", () => {
    const sql = migrations.map((migration) => migration.up).join("\n");

    for (const table of [
      "conversation_summaries",
      "debug_replay_captures",
      "metric_token_usage",
      "session_tags",
      "task_memories",
      "user_memories"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
