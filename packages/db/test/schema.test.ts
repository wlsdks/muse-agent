import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "../src/index.js";

describe("MuseDatabase", () => {
  it("exposes compile-time table contracts", () => {
    const tableNames = [
      "admin_alerts",
      "admin_cost_usage",
      "agent_runs",
      "agent_specs",
      "users",
      "conversation_summaries",
      "conversation_messages",
      "tool_calls",
      "checkpoints",
      "trace_events",
      "hook_traces",
      "mcp_servers",
      "mcp_security_policy",
      "scheduled_jobs",
      "scheduled_job_executions",
      "scheduled_job_locks",
      "session_tags",
      "task_memories",
      "metric_token_usage",
      "debug_replay_captures",
      "user_memories",
      "runtime_settings"
    ] satisfies readonly (keyof MuseDatabase)[];

    expect(tableNames).toContain("agent_runs");
  });
});
