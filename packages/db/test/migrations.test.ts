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
      "user_identities",
      "auth_token_revocations",
      "conversation_messages",
      "tool_calls",
      "pending_approvals",
      "checkpoints",
      "trace_events",
      "hook_traces",
      "admin_alerts",
      "admin_slos",
      "admin_cost_usage",
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

  it("covers Reactor persistent table names required by DB parity", () => {
    const sql = migrations.map((migration) => migration.up).join("\n");

    for (const table of [
      "admin_audits",
      "agent_eval_cases",
      "agent_eval_results",
      "agent_run_logs",
      "alert_instances",
      "alert_rules",
      "channel_faq_registrations",
      "conversation_summaries",
      "debug_replay_captures",
      "experiment_reports",
      "experiments",
      "feedback",
      "input_guard_rules",
      "intent_definitions",
      "metric_agent_executions",
      "metric_audit_trail",
      "metric_eval_results",
      "metric_guard_events",
      "metric_hitl_events",
      "metric_mcp_health",
      "metric_quota_events",
      "metric_sessions",
      "metric_spans",
      "metric_token_usage",
      "metric_tool_calls",
      "output_guard_rule_audits",
      "output_guard_rules",
      "personas",
      "prompt_templates",
      "prompt_versions",
      "rag_documents",
      "rag_ingestion_candidates",
      "rag_ingestion_policy",
      "session_tags",
      "slack_bot_instances",
      "slo_config",
      "task_memories",
      "tool_policy",
      "trials",
      "user_memories"
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});
