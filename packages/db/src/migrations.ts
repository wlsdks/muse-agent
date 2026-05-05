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
    `
  }
];

export function migrationNames(): readonly string[] {
  return migrations.map((migration) => migration.name);
}
