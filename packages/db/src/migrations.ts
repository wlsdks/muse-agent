export interface SqlMigration {
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

export const migrations: readonly SqlMigration[] = [
  {
    down: `
      DROP TABLE IF EXISTS metric_hitl_events;
      DROP TABLE IF EXISTS metric_quota_events;
      DROP TABLE IF EXISTS metric_audit_trail;
      DROP TABLE IF EXISTS metric_spans;
      DROP TABLE IF EXISTS metric_eval_results;
      DROP TABLE IF EXISTS metric_mcp_health;
      DROP TABLE IF EXISTS metric_guard_events;
      DROP TABLE IF EXISTS metric_sessions;
      DROP TABLE IF EXISTS metric_token_usage;
      DROP TABLE IF EXISTS metric_tool_calls;
      DROP TABLE IF EXISTS metric_agent_executions;
      DROP TABLE IF EXISTS debug_replay_captures;
      DROP TABLE IF EXISTS task_memories;
      DROP TABLE IF EXISTS user_memories;
      DROP TABLE IF EXISTS session_tags;
      DROP TABLE IF EXISTS conversation_summaries;
      DROP TABLE IF EXISTS slack_feedback_events;
      DROP TABLE IF EXISTS slack_response_tracking;
      DROP TABLE IF EXISTS channel_faq_registrations;
      DROP TABLE IF EXISTS slack_bot_instances;
      DROP TABLE IF EXISTS rag_documents;
      DROP TABLE IF EXISTS rag_ingestion_candidates;
      DROP TABLE IF EXISTS rag_ingestion_policy;
      DROP TABLE IF EXISTS experiment_reports;
      DROP TABLE IF EXISTS trials;
      DROP TABLE IF EXISTS experiments;
      DROP TABLE IF EXISTS prompt_versions;
      DROP TABLE IF EXISTS prompt_templates;
      DROP TABLE IF EXISTS personas;
      DROP TABLE IF EXISTS intent_definitions;
      DROP TABLE IF EXISTS feedback;
      DROP TABLE IF EXISTS tool_policy;
      DROP TABLE IF EXISTS output_guard_rule_audits;
      DROP TABLE IF EXISTS output_guard_rules;
      DROP TABLE IF EXISTS input_guard_rules;
      DROP TABLE IF EXISTS admin_audits;
      DROP TABLE IF EXISTS alert_instances;
      DROP TABLE IF EXISTS alert_rules;
      DROP TABLE IF EXISTS slo_config;
      DROP TABLE IF EXISTS model_pricing;
      DROP TABLE IF EXISTS tenants;
      DROP TABLE IF EXISTS trace_events;
      DROP TABLE IF EXISTS hook_traces;
      DROP TABLE IF EXISTS checkpoints;
      DROP TABLE IF EXISTS auth_token_revocations;
      DROP TABLE IF EXISTS user_identities;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS admin_cost_usage;
      DROP TABLE IF EXISTS admin_slos;
      DROP TABLE IF EXISTS admin_alerts;
      DROP TABLE IF EXISTS admin_tenants;
      DROP TABLE IF EXISTS scheduled_job_executions;
      DROP TABLE IF EXISTS scheduled_job_locks;
      DROP TABLE IF EXISTS scheduled_jobs;
      DROP TABLE IF EXISTS mcp_security_policy;
      DROP TABLE IF EXISTS mcp_servers;
      DROP TABLE IF EXISTS pending_approvals;
      DROP TABLE IF EXISTS tool_calls;
      DROP TABLE IF EXISTS conversation_messages;
      DROP TABLE IF EXISTS agent_runs;
      DROP TABLE IF EXISTS agent_specs;
      DROP TABLE IF EXISTS runtime_settings;
    `,
    name: "0001_runtime_state",
    up: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS agent_runs (
        id VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(128),
        status VARCHAR(32) NOT NULL,
        provider VARCHAR(128) NOT NULL,
        model VARCHAR(255) NOT NULL,
        mode VARCHAR(32) NOT NULL DEFAULT 'react',
        input TEXT NOT NULL,
        output TEXT,
        error TEXT,
        token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
        cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created_at
        ON agent_runs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created_at
        ON agent_runs(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(128) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE users DROP COLUMN IF EXISTS role;
      DROP TABLE IF EXISTS user_identities;
      DROP TABLE IF EXISTS alert_instances;
      DROP TABLE IF EXISTS slo_config;
      DROP TABLE IF EXISTS metric_agent_executions;
      DROP TABLE IF EXISTS metric_tool_calls;
      DROP TABLE IF EXISTS metric_sessions;
      DROP TABLE IF EXISTS metric_guard_events;
      DROP TABLE IF EXISTS metric_mcp_health;
      DROP TABLE IF EXISTS metric_eval_results;
      DROP TABLE IF EXISTS metric_spans;
      DROP TABLE IF EXISTS metric_quota_events;
      DROP TABLE IF EXISTS metric_hitl_events;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
        ON users(email);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        session_id VARCHAR(255) PRIMARY KEY,
        narrative TEXT NOT NULL,
        facts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        summarized_up_to INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS session_tags (
        id VARCHAR(128) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        label VARCHAR(120) NOT NULL,
        comment TEXT,
        created_by VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_tags_session_id ON session_tags(session_id);

      CREATE TABLE IF NOT EXISTS user_memories (
        user_id VARCHAR(255) PRIMARY KEY,
        facts JSONB NOT NULL DEFAULT '{}'::jsonb,
        preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
        recent_topics TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_model JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_user_memories_updated_at ON user_memories(updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_memories (
        task_id VARCHAR(128) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        goal TEXT NOT NULL,
        status VARCHAR(40) NOT NULL,
        plan_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        decisions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        blockers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_task_memories_session_user_status
        ON task_memories(session_id, user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_memories_session_status
        ON task_memories(session_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_memories_expires_at
        ON task_memories(expires_at);

      CREATE TABLE IF NOT EXISTS debug_replay_captures (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_hash VARCHAR(128),
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_prompt TEXT NOT NULL,
        error_code VARCHAR(128),
        error_message TEXT,
        model_id VARCHAR(255),
        tools_attempted JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_debug_replay_captures_captured_at
        ON debug_replay_captures(captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_debug_replay_captures_expires
        ON debug_replay_captures(expires_at);

      CREATE TABLE IF NOT EXISTS metric_token_usage (
        time TIMESTAMPTZ NOT NULL,
        run_id VARCHAR(128) NOT NULL,
        model VARCHAR(255) NOT NULL,
        provider VARCHAR(80) NOT NULL,
        step_type VARCHAR(40) NOT NULL DEFAULT 'act',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_cached_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        name VARCHAR(128),
        tool_call_id VARCHAR(128),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_messages_run_created_at
        ON conversation_messages(run_id, created_at);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id VARCHAR(128) PRIMARY KEY,
        run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
        risk VARCHAR(20) NOT NULL,
        status VARCHAR(32) NOT NULL,
        result TEXT,
        error TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_run_created_at
        ON tool_calls(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_name_created_at
        ON tool_calls(name, created_at DESC);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id VARCHAR(128) PRIMARY KEY,
        run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_run_step
        ON checkpoints(run_id, step);

      CREATE TABLE IF NOT EXISTS trace_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        span_id VARCHAR(128) NOT NULL,
        parent_span_id VARCHAR(128),
        name VARCHAR(255) NOT NULL,
        stage VARCHAR(128) NOT NULL,
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_trace_events_run_started_at
        ON trace_events(run_id, started_at);

      CREATE TABLE IF NOT EXISTS hook_traces (
        id VARCHAR(128) PRIMARY KEY,
        run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        hook_id VARCHAR(200) NOT NULL,
        lifecycle VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_hook_traces_run_started_at
        ON hook_traces(run_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_hook_traces_hook_status_created_at
        ON hook_traces(hook_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_settings (
        key VARCHAR(200) PRIMARY KEY,
        value TEXT NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'string',
        category VARCHAR(80) NOT NULL DEFAULT 'general',
        description TEXT,
        updated_by VARCHAR(128),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_settings_category
        ON runtime_settings(category);

      CREATE TABLE IF NOT EXISTS agent_specs (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        tool_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        system_prompt TEXT,
        mode VARCHAR(32) NOT NULL DEFAULT 'react',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        independent_execution BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        transport_type VARCHAR(32) NOT NULL,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        version VARCHAR(128),
        auto_connect BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_transport_name
        ON mcp_servers(transport_type, name);

      CREATE TABLE IF NOT EXISTS mcp_security_policy (
        id VARCHAR(32) PRIMARY KEY,
        allowed_server_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        max_tool_output_length INTEGER NOT NULL DEFAULT 50000,
        allowed_stdio_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        cron_expression VARCHAR(120) NOT NULL,
        timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
        job_type VARCHAR(32) NOT NULL,
        mcp_server_name VARCHAR(255),
        tool_name VARCHAR(255),
        tool_arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
        agent_prompt TEXT,
        persona_id VARCHAR(128),
        agent_system_prompt TEXT,
        agent_model VARCHAR(255),
        agent_max_tool_calls INTEGER,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        notification_channel_id VARCHAR(255),
        webhook_url TEXT,
        retry_on_failure BOOLEAN NOT NULL DEFAULT FALSE,
        max_retry_count INTEGER NOT NULL DEFAULT 3,
        execution_timeout_ms BIGINT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_run_at TIMESTAMPTZ,
        last_status VARCHAR(32),
        last_result TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled_name
        ON scheduled_jobs(enabled, name);
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_type_enabled
        ON scheduled_jobs(job_type, enabled);

      CREATE TABLE IF NOT EXISTS scheduled_job_executions (
        id VARCHAR(128) PRIMARY KEY,
        job_id VARCHAR(128) NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
        job_name VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL,
        result TEXT,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_job_executions_job_started_at
        ON scheduled_job_executions(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_job_executions_created_at
        ON scheduled_job_executions(created_at DESC);

      CREATE TABLE IF NOT EXISTS scheduled_job_locks (
        job_id VARCHAR(128) PRIMARY KEY REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
        owner_id VARCHAR(128) NOT NULL,
        locked_until TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_job_locks_locked_until
        ON scheduled_job_locks(locked_until);
    `
  },
  {
    down: `
      DROP INDEX IF EXISTS idx_conversation_summaries_user_id;
      ALTER TABLE IF EXISTS conversation_summaries
        DROP COLUMN IF EXISTS user_id;
    `,
    name: "0002_conversation_summaries_user_id",
    up: `
      ALTER TABLE conversation_summaries
        ADD COLUMN IF NOT EXISTS user_id VARCHAR(128);

      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_user_id
        ON conversation_summaries(user_id)
        WHERE user_id IS NOT NULL;
    `
  }
];

export function migrationNames(): readonly string[] {
  return migrations.map((migration) => migration.name);
}
