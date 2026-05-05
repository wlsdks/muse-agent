export interface SqlMigration {
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

export const migrations: readonly SqlMigration[] = [
  {
    down: `
      DROP TABLE IF EXISTS trace_events;
      DROP TABLE IF EXISTS checkpoints;
      DROP TABLE IF EXISTS scheduled_job_executions;
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
        workspace_id VARCHAR(128),
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
      CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_created_at
        ON agent_runs(workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created_at
        ON agent_runs(status, created_at DESC);

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

      CREATE TABLE IF NOT EXISTS pending_approvals (
        id VARCHAR(128) PRIMARY KEY,
        run_id VARCHAR(128) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        user_id VARCHAR(128) NOT NULL,
        tool_name VARCHAR(200) NOT NULL,
        arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        timeout_ms BIGINT NOT NULL DEFAULT 300000,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        reason TEXT,
        modified_arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_status_requested_at
        ON pending_approvals(status, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_user_status_requested_at
        ON pending_approvals(user_id, status, requested_at DESC);

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
    `
  }
];

export function migrationNames(): readonly string[] {
  return migrations.map((migration) => migration.name);
}
