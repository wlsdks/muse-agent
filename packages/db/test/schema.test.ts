import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "../src/index.js";

describe("MuseDatabase", () => {
  it("exposes compile-time table contracts", () => {
    const tableNames = [
      "agent_runs",
      "conversation_messages",
      "tool_calls",
      "pending_approvals",
      "checkpoints",
      "trace_events",
      "hook_traces",
      "mcp_servers",
      "mcp_security_policy",
      "scheduled_jobs",
      "scheduled_job_executions"
    ] satisfies readonly (keyof MuseDatabase)[];

    expect(tableNames).toContain("agent_runs");
  });
});
