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
      DROP TABLE IF EXISTS agent_eval_results;
      DROP TABLE IF EXISTS agent_eval_cases;
      DROP TABLE IF EXISTS agent_run_logs;
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

      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(128) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'user',
        tenant_id VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
        ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_tenant
        ON users(tenant_id);

      CREATE TABLE IF NOT EXISTS user_identities (
        slack_user_id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        jira_account_id VARCHAR(128),
        bitbucket_uuid VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_user_identities_email
        ON user_identities(email);

      CREATE TABLE IF NOT EXISTS auth_token_revocations (
        token_id VARCHAR(255) PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_auth_token_revocations_expires_at
        ON auth_token_revocations(expires_at);

      CREATE TABLE IF NOT EXISTS tenants (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(120) NOT NULL UNIQUE,
        plan VARCHAR(40) NOT NULL DEFAULT 'free',
        status VARCHAR(40) NOT NULL DEFAULT 'active',
        max_requests_per_month BIGINT NOT NULL DEFAULT 1000,
        max_tokens_per_month BIGINT NOT NULL DEFAULT 1000000,
        max_users INTEGER NOT NULL DEFAULT 5,
        max_agents INTEGER NOT NULL DEFAULT 3,
        max_mcp_servers INTEGER NOT NULL DEFAULT 5,
        billing_cycle_start INTEGER NOT NULL DEFAULT 1,
        billing_email VARCHAR(255),
        slo_availability DOUBLE PRECISION NOT NULL DEFAULT 0.995,
        slo_latency_p99_ms BIGINT NOT NULL DEFAULT 10000,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

      CREATE TABLE IF NOT EXISTS model_pricing (
        id VARCHAR(128) PRIMARY KEY,
        provider VARCHAR(80) NOT NULL,
        model VARCHAR(255) NOT NULL,
        prompt_price_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
        completion_price_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
        cached_input_price_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
        reasoning_price_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
        batch_prompt_price_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
        batch_completion_price_per_1k NUMERIC(18, 8) NOT NULL DEFAULT 0,
        effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_to TIMESTAMPTZ,
        UNIQUE(provider, model, effective_from)
      );

      CREATE INDEX IF NOT EXISTS idx_pricing_provider_model
        ON model_pricing(provider, model, effective_from DESC);

      CREATE TABLE IF NOT EXISTS admin_audits (
        id VARCHAR(128) PRIMARY KEY,
        category VARCHAR(80) NOT NULL,
        action VARCHAR(80) NOT NULL,
        actor VARCHAR(160) NOT NULL,
        resource_type VARCHAR(160),
        resource_id VARCHAR(255),
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_audits_created_at ON admin_audits(created_at);
      CREATE INDEX IF NOT EXISTS idx_admin_audits_category_action ON admin_audits(category, action);

      CREATE TABLE IF NOT EXISTS alert_rules (
        id VARCHAR(128) PRIMARY KEY,
        tenant_id VARCHAR(128),
        name VARCHAR(255) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type VARCHAR(40) NOT NULL,
        severity VARCHAR(40) NOT NULL DEFAULT 'warning',
        metric VARCHAR(120) NOT NULL,
        threshold DOUBLE PRECISION NOT NULL,
        window_minutes INTEGER NOT NULL DEFAULT 15,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        platform_only BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_alert_rules_tenant ON alert_rules(tenant_id);

      CREATE TABLE IF NOT EXISTS alert_instances (
        id VARCHAR(128) PRIMARY KEY,
        rule_id VARCHAR(128) NOT NULL,
        tenant_id VARCHAR(128),
        severity VARCHAR(40) NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'active',
        message TEXT NOT NULL,
        metric_value DOUBLE PRECISION NOT NULL DEFAULT 0,
        threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
        fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        acknowledged_by VARCHAR(160)
      );

      CREATE INDEX IF NOT EXISTS idx_alert_instances_tenant ON alert_instances(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_alert_instances_rule ON alert_instances(rule_id);

      CREATE TABLE IF NOT EXISTS slo_config (
        id VARCHAR(128) PRIMARY KEY,
        tenant_id VARCHAR(128) NOT NULL UNIQUE,
        availability_target DOUBLE PRECISION NOT NULL DEFAULT 0.995,
        latency_p99_target_ms BIGINT NOT NULL DEFAULT 10000,
        apdex_satisfied_ms BIGINT NOT NULL DEFAULT 5000,
        apdex_tolerating_ms BIGINT NOT NULL DEFAULT 20000,
        error_budget_window_days INTEGER NOT NULL DEFAULT 30,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS input_guard_rules (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        pattern TEXT NOT NULL,
        pattern_type VARCHAR(32) NOT NULL DEFAULT 'regex',
        action VARCHAR(32) NOT NULL DEFAULT 'block',
        priority INTEGER NOT NULL DEFAULT 100,
        category VARCHAR(80) NOT NULL DEFAULT 'custom',
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_input_guard_rules_enabled ON input_guard_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_input_guard_rules_priority ON input_guard_rules(priority ASC);
      CREATE INDEX IF NOT EXISTS idx_input_guard_rules_category ON input_guard_rules(category);

      CREATE TABLE IF NOT EXISTS output_guard_rules (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        pattern TEXT NOT NULL,
        action VARCHAR(32) NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        replacement TEXT NOT NULL DEFAULT '[REDACTED]',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_output_guard_rules_enabled ON output_guard_rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_output_guard_rules_priority ON output_guard_rules(enabled, priority, created_at);

      CREATE TABLE IF NOT EXISTS output_guard_rule_audits (
        id VARCHAR(128) PRIMARY KEY,
        rule_id VARCHAR(128),
        action VARCHAR(40) NOT NULL,
        actor VARCHAR(160) NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_output_guard_rule_audits_created_at ON output_guard_rule_audits(created_at);
      CREATE INDEX IF NOT EXISTS idx_output_guard_rule_audits_rule_id ON output_guard_rule_audits(rule_id);

      CREATE TABLE IF NOT EXISTS tool_policy (
        id VARCHAR(80) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        write_tool_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        deny_write_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
        deny_write_message TEXT NOT NULL DEFAULT 'Error: This tool is not allowed in this channel',
        allow_write_tool_names_in_deny_channels BOOLEAN NOT NULL DEFAULT FALSE,
        allow_write_tool_names_by_channel JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS feedback (
        feedback_id VARCHAR(128) PRIMARY KEY,
        query TEXT NOT NULL,
        response TEXT NOT NULL,
        rating VARCHAR(40) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        comment TEXT,
        session_id VARCHAR(255),
        run_id VARCHAR(128),
        user_id VARCHAR(255),
        intent VARCHAR(80),
        domain VARCHAR(80),
        model VARCHAR(255),
        prompt_version INTEGER,
        prompt_template_id VARCHAR(255),
        tools_used JSONB NOT NULL DEFAULT '[]'::jsonb,
        duration_ms BIGINT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        review_status VARCHAR(40) NOT NULL DEFAULT 'inbox',
        reviewed_by VARCHAR(255),
        reviewed_at TIMESTAMPTZ,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
      CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback(timestamp);
      CREATE INDEX IF NOT EXISTS idx_feedback_session_id ON feedback(session_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_run_id ON feedback(run_id);

      CREATE TABLE IF NOT EXISTS intent_definitions (
        name VARCHAR(120) PRIMARY KEY,
        description TEXT NOT NULL,
        examples JSONB NOT NULL DEFAULT '[]'::jsonb,
        keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        profile JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_intent_definitions_enabled ON intent_definitions(enabled);

      CREATE TABLE IF NOT EXISTS personas (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        system_prompt TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        identity VARCHAR(255),
        prompt_template_id VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS prompt_templates (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS prompt_versions (
        id VARCHAR(128) PRIMARY KEY,
        template_id VARCHAR(128) NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'draft',
        change_log TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(template_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_versions_template_id ON prompt_versions(template_id);
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_status ON prompt_versions(template_id, status);

      CREATE TABLE IF NOT EXISTS experiments (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        template_id VARCHAR(255) NOT NULL,
        baseline_version_id VARCHAR(255) NOT NULL,
        candidate_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        test_queries JSONB NOT NULL DEFAULT '[]'::jsonb,
        evaluation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        model VARCHAR(255),
        judge_model VARCHAR(255),
        temperature DOUBLE PRECISION NOT NULL DEFAULT 0.3,
        repetitions INTEGER NOT NULL DEFAULT 1,
        auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
        created_by VARCHAR(255) NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
      CREATE INDEX IF NOT EXISTS idx_experiments_template_id ON experiments(template_id);
      CREATE INDEX IF NOT EXISTS idx_experiments_created_at ON experiments(created_at DESC);

      CREATE TABLE IF NOT EXISTS trials (
        id VARCHAR(128) PRIMARY KEY,
        experiment_id VARCHAR(128) NOT NULL,
        prompt_version_id VARCHAR(255) NOT NULL,
        prompt_version_number INTEGER NOT NULL,
        test_query TEXT NOT NULL,
        repetition_index INTEGER NOT NULL DEFAULT 0,
        response TEXT,
        success BOOLEAN NOT NULL DEFAULT FALSE,
        error_message TEXT,
        tools_used JSONB NOT NULL DEFAULT '[]'::jsonb,
        token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        evaluations JSONB NOT NULL DEFAULT '[]'::jsonb,
        executed_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trials_experiment_id ON trials(experiment_id);

      CREATE TABLE IF NOT EXISTS experiment_reports (
        experiment_id VARCHAR(128) PRIMARY KEY,
        report_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rag_ingestion_policy (
        id VARCHAR(80) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        require_review BOOLEAN NOT NULL DEFAULT TRUE,
        allowed_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_query_chars INTEGER NOT NULL DEFAULT 10,
        min_response_chars INTEGER NOT NULL DEFAULT 20,
        blocked_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rag_ingestion_candidates (
        id VARCHAR(128) PRIMARY KEY,
        run_id VARCHAR(128) NOT NULL UNIQUE,
        user_id VARCHAR(255) NOT NULL,
        session_id VARCHAR(255),
        channel VARCHAR(120),
        query TEXT NOT NULL,
        response TEXT NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'pending',
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by VARCHAR(255),
        review_comment TEXT,
        ingested_document_id VARCHAR(128)
      );

      CREATE INDEX IF NOT EXISTS idx_rag_ingestion_candidates_status_captured_at
        ON rag_ingestion_candidates(status, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rag_ingestion_candidates_channel
        ON rag_ingestion_candidates(channel);

      CREATE TABLE IF NOT EXISTS rag_documents (
        id VARCHAR(128) PRIMARY KEY,
        content TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        content_hash VARCHAR(64) NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 1,
        chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        indexed BOOLEAN NOT NULL DEFAULT TRUE,
        source VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rag_documents_created_at
        ON rag_documents(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rag_documents_content_hash
        ON rag_documents(content_hash);
      CREATE INDEX IF NOT EXISTS idx_rag_documents_source
        ON rag_documents(source);
      CREATE INDEX IF NOT EXISTS idx_rag_documents_metadata
        ON rag_documents USING GIN (metadata);

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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

      CREATE TABLE IF NOT EXISTS slack_bot_instances (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        bot_token VARCHAR(500) NOT NULL,
        app_token VARCHAR(500) NOT NULL,
        persona_id VARCHAR(128) NOT NULL,
        default_channel VARCHAR(120),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_slack_bot_instances_enabled
        ON slack_bot_instances(enabled);

      CREATE TABLE IF NOT EXISTS channel_faq_registrations (
        channel_id VARCHAR(80) PRIMARY KEY,
        channel_name VARCHAR(160),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        auto_reply_mode VARCHAR(32) NOT NULL DEFAULT 'MENTION',
        confidence_threshold REAL NOT NULL DEFAULT 0.8,
        days_back INTEGER NOT NULL DEFAULT 30,
        re_ingest_interval_hours INTEGER NOT NULL DEFAULT 24,
        last_ingested_at TIMESTAMPTZ,
        last_message_count INTEGER,
        last_chunk_count INTEGER,
        last_status VARCHAR(40),
        last_error TEXT,
        registered_by VARCHAR(128),
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_channel_faq_due
        ON channel_faq_registrations(enabled, last_ingested_at);

      CREATE TABLE IF NOT EXISTS slack_response_tracking (
        channel_id VARCHAR(80) NOT NULL,
        message_ts VARCHAR(80) NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        user_prompt TEXT NOT NULL,
        response TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(channel_id, message_ts)
      );

      CREATE INDEX IF NOT EXISTS idx_slack_response_tracking_expires_at
        ON slack_response_tracking(expires_at);
      CREATE INDEX IF NOT EXISTS idx_slack_response_tracking_session_id
        ON slack_response_tracking(session_id);

      CREATE TABLE IF NOT EXISTS slack_feedback_events (
        id VARCHAR(128) PRIMARY KEY,
        channel_id VARCHAR(80) NOT NULL,
        message_ts VARCHAR(80) NOT NULL,
        session_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        rating VARCHAR(40) NOT NULL,
        query TEXT NOT NULL,
        response TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_slack_feedback_events_session_id
        ON slack_feedback_events(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_slack_feedback_events_message
        ON slack_feedback_events(channel_id, message_ts);
      CREATE INDEX IF NOT EXISTS idx_slack_feedback_events_rating
        ON slack_feedback_events(rating, created_at DESC);

      CREATE TABLE IF NOT EXISTS agent_run_logs (
        run_id VARCHAR(128) PRIMARY KEY,
        eval_case_id VARCHAR(255),
        user_input TEXT NOT NULL,
        agent_type VARCHAR(128) NOT NULL,
        model VARCHAR(255) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL,
        final_answer TEXT NOT NULL,
        tool_calls_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        retrieved_chunks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        token_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
        errors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        tool_exposure_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_agent_run_logs_started_at ON agent_run_logs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_run_logs_eval_case ON agent_run_logs(eval_case_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_run_logs_agent_type ON agent_run_logs(agent_type, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_run_logs_expires_at ON agent_run_logs(expires_at);

      CREATE TABLE IF NOT EXISTS agent_eval_cases (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        user_input TEXT NOT NULL,
        expected_answer_contains_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        forbidden_answer_contains_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected_tool_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        forbidden_tool_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        agent_type VARCHAR(128),
        model VARCHAR(255),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_score DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        source_run_id VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_agent_eval_cases_enabled_updated
        ON agent_eval_cases(enabled, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_eval_cases_source_run
        ON agent_eval_cases(source_run_id);

      CREATE TABLE IF NOT EXISTS agent_eval_results (
        id VARCHAR(128) PRIMARY KEY,
        case_id VARCHAR(128) NOT NULL,
        run_id VARCHAR(128),
        tier VARCHAR(80) NOT NULL,
        passed BOOLEAN NOT NULL,
        score DOUBLE PRECISION NOT NULL,
        reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_agent_eval_results_case_time
        ON agent_eval_results(case_id, evaluated_at DESC);

      CREATE TABLE IF NOT EXISTS debug_replay_captures (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id VARCHAR(128) NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_debug_replay_captures_tenant_time
        ON debug_replay_captures(tenant_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_debug_replay_captures_expires
        ON debug_replay_captures(expires_at);

      CREATE TABLE IF NOT EXISTS metric_agent_executions (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        run_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128),
        session_id VARCHAR(128),
        channel VARCHAR(80),
        success BOOLEAN NOT NULL,
        error_code VARCHAR(80),
        error_class VARCHAR(80),
        duration_ms BIGINT NOT NULL DEFAULT 0,
        llm_duration_ms BIGINT NOT NULL DEFAULT 0,
        tool_duration_ms BIGINT NOT NULL DEFAULT 0,
        guard_duration_ms BIGINT NOT NULL DEFAULT 0,
        queue_wait_ms BIGINT NOT NULL DEFAULT 0,
        is_streaming BOOLEAN NOT NULL DEFAULT FALSE,
        tool_count INTEGER NOT NULL DEFAULT 0,
        persona_id VARCHAR(128),
        prompt_template_id VARCHAR(128),
        intent_category VARCHAR(80),
        guard_rejected BOOLEAN NOT NULL DEFAULT FALSE,
        guard_stage VARCHAR(80),
        guard_category VARCHAR(80),
        retry_count INTEGER NOT NULL DEFAULT 0,
        fallback_used BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS metric_tool_calls (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        run_id VARCHAR(128) NOT NULL,
        tool_name VARCHAR(255) NOT NULL,
        tool_source VARCHAR(40) NOT NULL DEFAULT 'local',
        mcp_server_name VARCHAR(120),
        call_index INTEGER NOT NULL DEFAULT 0,
        success BOOLEAN NOT NULL,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        error_class VARCHAR(80),
        error_message VARCHAR(500)
      );

      CREATE TABLE IF NOT EXISTS metric_token_usage (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
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

      CREATE TABLE IF NOT EXISTS metric_sessions (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        session_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128),
        channel VARCHAR(80),
        turn_count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        total_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
        first_response_latency_ms BIGINT NOT NULL DEFAULT 0,
        outcome VARCHAR(40) NOT NULL DEFAULT 'resolved',
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metric_guard_events (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        user_id VARCHAR(128),
        channel VARCHAR(80),
        stage VARCHAR(80) NOT NULL,
        category VARCHAR(80) NOT NULL,
        reason_class VARCHAR(80),
        reason_detail VARCHAR(500),
        is_output_guard BOOLEAN NOT NULL DEFAULT FALSE,
        action VARCHAR(40) NOT NULL DEFAULT 'rejected'
      );

      CREATE TABLE IF NOT EXISTS metric_mcp_health (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        server_name VARCHAR(120) NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'connected',
        response_time_ms BIGINT NOT NULL DEFAULT 0,
        error_class VARCHAR(80),
        error_message VARCHAR(500),
        tool_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS metric_eval_results (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        eval_run_id VARCHAR(128) NOT NULL,
        test_case_id VARCHAR(128) NOT NULL,
        pass BOOLEAN NOT NULL,
        score DOUBLE PRECISION NOT NULL DEFAULT 0,
        latency_ms BIGINT NOT NULL DEFAULT 0,
        token_usage INTEGER NOT NULL DEFAULT 0,
        cost NUMERIC(18, 8) NOT NULL DEFAULT 0,
        assertion_type VARCHAR(80),
        failure_class VARCHAR(80),
        failure_detail VARCHAR(500),
        tags TEXT
      );

      CREATE TABLE IF NOT EXISTS metric_spans (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        trace_id VARCHAR(64) NOT NULL,
        span_id VARCHAR(64) NOT NULL,
        parent_span_id VARCHAR(64),
        run_id VARCHAR(128),
        operation_name VARCHAR(255) NOT NULL,
        service_name VARCHAR(120) NOT NULL,
        duration_ms BIGINT NOT NULL,
        success BOOLEAN NOT NULL,
        error_class VARCHAR(80),
        attributes JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS metric_audit_trail (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        actor_id VARCHAR(128),
        actor_email VARCHAR(255),
        event_type VARCHAR(80) NOT NULL,
        resource_type VARCHAR(80),
        resource_id VARCHAR(128),
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_ip VARCHAR(45)
      );

      CREATE TABLE IF NOT EXISTS metric_quota_events (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        action VARCHAR(80) NOT NULL,
        current_usage BIGINT NOT NULL DEFAULT 0,
        quota_limit BIGINT NOT NULL DEFAULT 0,
        usage_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
        reason VARCHAR(500)
      );

      CREATE TABLE IF NOT EXISTS metric_hitl_events (
        time TIMESTAMPTZ NOT NULL,
        tenant_id VARCHAR(128) NOT NULL,
        run_id VARCHAR(128) NOT NULL,
        tool_name VARCHAR(255) NOT NULL,
        approved BOOLEAN NOT NULL,
        wait_ms BIGINT NOT NULL DEFAULT 0,
        rejection_reason VARCHAR(500)
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

      CREATE TABLE IF NOT EXISTS admin_tenants (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        monthly_budget_usd NUMERIC(18, 8),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_tenants_status_updated_at
        ON admin_tenants(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS admin_alerts (
        id VARCHAR(128) PRIMARY KEY,
        severity VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'open',
        message TEXT NOT NULL,
        target VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acknowledged_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_admin_alerts_status_created_at
        ON admin_alerts(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_alerts_target_created_at
        ON admin_alerts(target, created_at DESC);

      CREATE TABLE IF NOT EXISTS admin_slos (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        target DOUBLE PRECISION NOT NULL,
        actual DOUBLE PRECISION,
        "window" VARCHAR(80) NOT NULL,
        status VARCHAR(32) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_slos_status_updated_at
        ON admin_slos(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS admin_cost_usage (
        id VARCHAR(128) PRIMARY KEY,
        tenant_id VARCHAR(128),
        model VARCHAR(255),
        cost_usd NUMERIC(18, 8) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_admin_cost_usage_tenant_created_at
        ON admin_cost_usage(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_cost_usage_model_created_at
        ON admin_cost_usage(model, created_at DESC);

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
  }
];

export function migrationNames(): readonly string[] {
  return migrations.map((migration) => migration.name);
}
