import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "../src/index.js";

describe("MuseDatabase", () => {
  it("exposes compile-time table contracts", () => {
    const tableNames = [
      "admin_tenants",
      "admin_alerts",
      "admin_slos",
      "admin_cost_usage",
      "agent_runs",
      "users",
      "user_identities",
      "auth_token_revocations",
      "channel_faq_registrations",
      "conversation_summaries",
      "conversation_messages",
      "tool_calls",
      "pending_approvals",
      "checkpoints",
      "trace_events",
      "hook_traces",
      "mcp_servers",
      "mcp_security_policy",
      "scheduled_jobs",
      "scheduled_job_executions",
      "scheduled_job_locks",
      "slack_bot_instances"
    ] satisfies readonly (keyof MuseDatabase)[];

    expect(tableNames).toContain("agent_runs");
  });
});
