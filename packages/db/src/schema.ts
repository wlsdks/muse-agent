import type { JsonValue, RunStatus } from "@muse/shared";
import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type NumericString = ColumnType<string, string | number | undefined, string | number>;
type NullableNumericString = ColumnType<string | null, string | number | null | undefined, string | number | null>;
type JsonColumn<T extends JsonValue = JsonValue> = ColumnType<T, T | string | undefined, T | string>;
type CompatibilityTable = Record<string, ColumnType<unknown, unknown, unknown>>;

export interface MuseDatabase {
  readonly admin_audits: AdminAuditTable;
  readonly admin_alerts: AdminAlertTable;
  readonly admin_cost_usage: AdminCostUsageTable;
  readonly admin_slos: AdminSloTable;
  readonly admin_tenants: AdminTenantTable;
  readonly agent_eval_cases: AgentEvalCaseTable;
  readonly agent_eval_results: AgentEvalResultTable;
  readonly agent_run_logs: AgentRunLogTable;
  readonly agent_runs: AgentRunTable;
  readonly agent_specs: AgentSpecTable;
  readonly alert_instances: CompatibilityTable;
  readonly alert_rules: AlertRuleTable;
  readonly auth_token_revocations: AuthTokenRevocationTable;
  readonly channel_faq_registrations: ChannelFaqRegistrationTable;
  readonly checkpoints: CheckpointTable;
  readonly conversation_messages: ConversationMessageTable;
  readonly conversation_summaries: ConversationSummaryTable;
  readonly debug_replay_captures: DebugReplayCaptureTable;
  readonly experiment_reports: ExperimentReportTable;
  readonly experiments: ExperimentTable;
  readonly feedback: FeedbackTable;
  readonly hook_traces: HookTraceTable;
  readonly input_guard_rules: InputGuardRuleTable;
  readonly intent_definitions: IntentDefinitionTable;
  readonly mcp_security_policy: McpSecurityPolicyTable;
  readonly mcp_servers: McpServerTable;
  readonly metric_agent_executions: CompatibilityTable;
  readonly metric_audit_trail: MetricAuditTrailTable;
  readonly metric_eval_results: CompatibilityTable;
  readonly metric_guard_events: CompatibilityTable;
  readonly metric_hitl_events: CompatibilityTable;
  readonly metric_mcp_health: CompatibilityTable;
  readonly metric_quota_events: CompatibilityTable;
  readonly metric_sessions: CompatibilityTable;
  readonly metric_spans: CompatibilityTable;
  readonly metric_token_usage: CompatibilityTable;
  readonly metric_tool_calls: CompatibilityTable;
  readonly model_pricing: ModelPricingTable;
  readonly output_guard_rule_audits: OutputGuardRuleAuditTable;
  readonly output_guard_rules: OutputGuardRuleTable;
  readonly pending_approvals: PendingApprovalTable;
  readonly personas: PersonaTable;
  readonly prompt_templates: PromptTemplateTable;
  readonly prompt_versions: PromptVersionTable;
  readonly rag_ingestion_candidates: RagIngestionCandidateTable;
  readonly rag_ingestion_policy: RagIngestionPolicyTable;
  readonly runtime_settings: RuntimeSettingTable;
  readonly scheduled_job_executions: ScheduledJobExecutionTable;
  readonly scheduled_job_locks: ScheduledJobLockTable;
  readonly scheduled_jobs: ScheduledJobTable;
  readonly session_tags: SessionTagTable;
  readonly slack_bot_instances: SlackBotInstanceTable;
  readonly slack_feedback_events: SlackFeedbackEventTable;
  readonly slack_response_tracking: SlackResponseTrackingTable;
  readonly slo_config: CompatibilityTable;
  readonly task_memories: CompatibilityTable;
  readonly tenants: CompatibilityTable;
  readonly tool_calls: ToolCallTable;
  readonly tool_policy: ToolPolicyTable;
  readonly trace_events: TraceEventTable;
  readonly trials: TrialTable;
  readonly user_identities: UserIdentityTable;
  readonly user_memories: UserMemoryTable;
  readonly users: UserTable;
}

export interface AdminTenantTable {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "suspended" | "disabled";
  readonly monthly_budget_usd: NullableNumericString;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface AdminAlertTable {
  readonly id: string;
  readonly severity: "info" | "warning" | "critical";
  readonly status: "open" | "acknowledged" | "resolved";
  readonly message: string;
  readonly target: string | null;
  readonly created_at: Timestamp;
  readonly acknowledged_at: NullableTimestamp;
}

export interface AdminSloTable {
  readonly id: string;
  readonly name: string;
  readonly target: number;
  readonly actual: number | null;
  readonly window: string;
  readonly status: "healthy" | "at_risk" | "violated";
  readonly updated_at: Timestamp;
}

export interface AdminCostUsageTable {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly model: string | null;
  readonly cost_usd: NumericString;
  readonly created_at: Timestamp;
}

export interface AdminAuditTable {
  readonly id: string;
  readonly category: string;
  readonly action: string;
  readonly actor: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly detail: string | null;
  readonly created_at: Timestamp;
}

export interface MetricAuditTrailTable {
  readonly time: Timestamp;
  readonly tenant_id: string;
  readonly actor_id: string | null;
  readonly actor_email: string | null;
  readonly event_type: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly detail: JsonColumn;
  readonly source_ip: string | null;
}

export interface ModelPricingTable {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt_price_per_1k: NumericString;
  readonly completion_price_per_1k: NumericString;
  readonly cached_input_price_per_1k: NumericString;
  readonly reasoning_price_per_1k: NumericString;
  readonly batch_prompt_price_per_1k: NumericString;
  readonly batch_completion_price_per_1k: NumericString;
  readonly effective_from: Timestamp;
  readonly effective_to: NullableTimestamp;
}

export interface AlertRuleTable {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly severity: string;
  readonly metric: string;
  readonly threshold: number;
  readonly window_minutes: number;
  readonly enabled: boolean;
  readonly platform_only: boolean;
  readonly created_at: Timestamp;
}

export interface FeedbackTable {
  readonly feedback_id: string;
  readonly query: string;
  readonly response: string;
  readonly rating: string;
  readonly timestamp: Timestamp;
  readonly comment: string | null;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly user_id: string | null;
  readonly intent: string | null;
  readonly domain: string | null;
  readonly model: string | null;
  readonly prompt_version: number | null;
  readonly prompt_template_id: string | null;
  readonly tools_used: JsonColumn;
  readonly duration_ms: number | null;
  readonly tags: JsonColumn;
  readonly review_status: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: NullableTimestamp;
  readonly version: number;
}

export interface ExperimentTable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly template_id: string;
  readonly baseline_version_id: string;
  readonly candidate_version_ids: JsonColumn;
  readonly test_queries: JsonColumn;
  readonly evaluation_config: JsonColumn;
  readonly model: string | null;
  readonly judge_model: string | null;
  readonly temperature: number;
  readonly repetitions: number;
  readonly auto_generated: boolean;
  readonly status: string;
  readonly created_by: string;
  readonly created_at: Timestamp;
  readonly started_at: NullableTimestamp;
  readonly completed_at: NullableTimestamp;
  readonly error_message: string | null;
}

export interface TrialTable {
  readonly id: string;
  readonly experiment_id: string;
  readonly prompt_version_id: string;
  readonly prompt_version_number: number;
  readonly test_query: string;
  readonly repetition_index: number;
  readonly response: string | null;
  readonly success: boolean;
  readonly error_message: string | null;
  readonly tools_used: JsonColumn;
  readonly token_usage: JsonColumn;
  readonly duration_ms: ColumnType<number, number | string | bigint | undefined, number | string | bigint>;
  readonly evaluations: JsonColumn;
  readonly executed_at: Timestamp;
}

export interface ExperimentReportTable {
  readonly experiment_id: string;
  readonly report_data: JsonColumn;
  readonly created_at: Timestamp;
}

export interface AgentRunLogTable {
  readonly run_id: string;
  readonly eval_case_id: string | null;
  readonly user_input: string;
  readonly agent_type: string;
  readonly model: string;
  readonly started_at: Timestamp;
  readonly ended_at: Timestamp;
  readonly final_answer: string;
  readonly tool_calls_json: JsonColumn;
  readonly retrieved_chunks_json: JsonColumn;
  readonly token_usage_json: JsonColumn;
  readonly cost_usd: NumericString;
  readonly errors_json: JsonColumn;
  readonly tool_exposure_json: JsonColumn;
  readonly created_at: Timestamp;
  readonly expires_at: NullableTimestamp;
}

export interface AgentEvalCaseTable {
  readonly id: string;
  readonly name: string;
  readonly user_input: string;
  readonly expected_answer_contains_json: JsonColumn;
  readonly forbidden_answer_contains_json: JsonColumn;
  readonly expected_tool_names_json: JsonColumn;
  readonly forbidden_tool_names_json: JsonColumn;
  readonly agent_type: string | null;
  readonly model: string | null;
  readonly enabled: boolean;
  readonly tags_json: JsonColumn;
  readonly min_score: number;
  readonly source_run_id: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface AgentEvalResultTable {
  readonly id: string;
  readonly case_id: string;
  readonly run_id: string | null;
  readonly tier: string;
  readonly passed: boolean;
  readonly score: number;
  readonly reasons_json: JsonColumn;
  readonly evaluated_at: Timestamp;
}

export interface DebugReplayCaptureTable {
  readonly id: ColumnType<string, string | undefined, string>;
  readonly tenant_id: string;
  readonly user_hash: string | null;
  readonly captured_at: Timestamp;
  readonly user_prompt: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly model_id: string | null;
  readonly tools_attempted: JsonColumn;
  readonly metadata_json: JsonColumn;
  readonly expires_at: Timestamp;
}

export interface IntentDefinitionTable {
  readonly name: string;
  readonly description: string;
  readonly examples: JsonColumn;
  readonly keywords: JsonColumn;
  readonly profile: JsonColumn;
  readonly enabled: boolean;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface PersonaTable {
  readonly id: string;
  readonly name: string;
  readonly system_prompt: string;
  readonly is_default: boolean;
  readonly identity: string | null;
  readonly prompt_template_id: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface PromptTemplateTable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface PromptVersionTable {
  readonly id: string;
  readonly template_id: string;
  readonly version: number;
  readonly content: string;
  readonly status: string;
  readonly change_log: string;
  readonly created_at: Timestamp;
}

export interface UserTable {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly password_hash: string;
  readonly role: "user" | "admin" | "admin_manager" | "admin_developer";
  readonly tenant_id: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface UserIdentityTable {
  readonly slack_user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly jira_account_id: string | null;
  readonly bitbucket_uuid: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface AuthTokenRevocationTable {
  readonly token_id: string;
  readonly expires_at: Timestamp;
  readonly revoked_at: Timestamp;
}

export interface ConversationSummaryTable {
  readonly session_id: string;
  readonly narrative: string;
  readonly facts_json: JsonColumn;
  readonly summarized_up_to: number;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface AgentRunTable {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly user_id: string | null;
  readonly status: RunStatus;
  readonly provider: string;
  readonly model: string;
  readonly mode: string;
  readonly input: string;
  readonly output: string | null;
  readonly error: string | null;
  readonly token_usage: JsonColumn;
  readonly cost_usd: NumericString;
  readonly started_at: NullableTimestamp;
  readonly completed_at: NullableTimestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface ConversationMessageTable {
  readonly id: Generated<string>;
  readonly run_id: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name: string | null;
  readonly tool_call_id: string | null;
  readonly metadata: JsonColumn;
  readonly created_at: Timestamp;
}

export interface ToolCallTable {
  readonly id: string;
  readonly run_id: string;
  readonly name: string;
  readonly arguments: JsonColumn;
  readonly risk: "read" | "write" | "execute";
  readonly status: "queued" | "running" | "completed" | "failed" | "blocked";
  readonly result: string | null;
  readonly error: string | null;
  readonly started_at: NullableTimestamp;
  readonly completed_at: NullableTimestamp;
  readonly created_at: Timestamp;
}

export interface ToolPolicyTable {
  readonly id: string;
  readonly enabled: boolean;
  readonly write_tool_names: JsonColumn;
  readonly deny_write_channels: JsonColumn;
  readonly deny_write_message: string;
  readonly allow_write_tool_names_in_deny_channels: JsonColumn;
  readonly allow_write_tool_names_by_channel: JsonColumn;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface InputGuardRuleTable {
  readonly id: string;
  readonly name: string;
  readonly pattern: string;
  readonly pattern_type: string;
  readonly action: string;
  readonly priority: number;
  readonly category: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface OutputGuardRuleTable {
  readonly id: string;
  readonly name: string;
  readonly pattern: string;
  readonly action: string;
  readonly priority: number;
  readonly replacement: string;
  readonly enabled: boolean;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface OutputGuardRuleAuditTable {
  readonly id: string;
  readonly rule_id: string | null;
  readonly action: string;
  readonly actor: string;
  readonly detail: string | null;
  readonly created_at: Timestamp;
}

export interface UserMemoryTable {
  readonly user_id: string;
  readonly facts: JsonColumn;
  readonly preferences: JsonColumn;
  readonly recent_topics: string;
  readonly updated_at: Timestamp;
}

export interface SessionTagTable {
  readonly id: string;
  readonly session_id: string;
  readonly label: string;
  readonly comment: string | null;
  readonly created_by: string;
  readonly created_at: number;
}

export interface RagIngestionPolicyTable {
  readonly id: string;
  readonly enabled: boolean;
  readonly require_review: boolean;
  readonly allowed_channels: JsonColumn;
  readonly min_query_chars: number;
  readonly min_response_chars: number;
  readonly blocked_patterns: JsonColumn;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface RagIngestionCandidateTable {
  readonly id: string;
  readonly run_id: string;
  readonly user_id: string;
  readonly session_id: string | null;
  readonly channel: string | null;
  readonly query: string;
  readonly response: string;
  readonly status: "PENDING" | "REJECTED" | "INGESTED";
  readonly captured_at: Timestamp;
  readonly reviewed_at: NullableTimestamp;
  readonly reviewed_by: string | null;
  readonly review_comment: string | null;
  readonly ingested_document_id: string | null;
}

export interface SlackBotInstanceTable {
  readonly id: string;
  readonly name: string;
  readonly bot_token: string;
  readonly app_token: string;
  readonly persona_id: string;
  readonly default_channel: string | null;
  readonly enabled: boolean;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface ChannelFaqRegistrationTable {
  readonly channel_id: string;
  readonly channel_name: string | null;
  readonly enabled: boolean;
  readonly auto_reply_mode: "MENTION" | "ALWAYS" | "OFF";
  readonly confidence_threshold: number;
  readonly days_back: number;
  readonly re_ingest_interval_hours: number;
  readonly last_ingested_at: NullableTimestamp;
  readonly last_message_count: number | null;
  readonly last_chunk_count: number | null;
  readonly last_status: "OK" | "FAILED" | "RUNNING" | null;
  readonly last_error: string | null;
  readonly registered_by: string | null;
  readonly registered_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface SlackResponseTrackingTable {
  readonly channel_id: string;
  readonly message_ts: string;
  readonly session_id: string;
  readonly user_prompt: string;
  readonly response: string | null;
  readonly expires_at: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface SlackFeedbackEventTable {
  readonly id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly session_id: string;
  readonly user_id: string;
  readonly rating: "thumbs_down" | "thumbs_up";
  readonly query: string;
  readonly response: string;
  readonly metadata: JsonColumn;
  readonly created_at: Timestamp;
}

export interface PendingApprovalTable {
  readonly id: string;
  readonly run_id: string;
  readonly user_id: string;
  readonly tool_name: string;
  readonly arguments: JsonColumn;
  readonly context: JsonColumn;
  readonly timeout_ms: number;
  readonly status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  readonly reason: string | null;
  readonly modified_arguments: JsonColumn;
  readonly requested_at: Timestamp;
  readonly resolved_at: NullableTimestamp;
}

export interface CheckpointTable {
  readonly id: string;
  readonly run_id: string;
  readonly step: number;
  readonly state: JsonColumn;
  readonly created_at: Timestamp;
}

export interface TraceEventTable {
  readonly id: Generated<string>;
  readonly run_id: string;
  readonly span_id: string;
  readonly parent_span_id: string | null;
  readonly name: string;
  readonly stage: string;
  readonly attributes: JsonColumn;
  readonly started_at: Timestamp;
  readonly ended_at: NullableTimestamp;
}

export interface HookTraceTable {
  readonly id: string;
  readonly run_id: string;
  readonly hook_id: string;
  readonly lifecycle: "beforeStart" | "beforeTool" | "afterTool" | "afterComplete" | "onError";
  readonly status: "completed" | "failed";
  readonly duration_ms: number;
  readonly error: string | null;
  readonly metadata: JsonColumn;
  readonly started_at: Timestamp;
  readonly completed_at: Timestamp;
  readonly created_at: Timestamp;
}

export interface RuntimeSettingTable {
  readonly key: string;
  readonly value: string;
  readonly type: "string" | "number" | "boolean" | "json";
  readonly category: string;
  readonly description: string | null;
  readonly updated_by: string | null;
  readonly updated_at: Timestamp;
}

export interface AgentSpecTable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tool_names: JsonColumn;
  readonly keywords: JsonColumn;
  readonly system_prompt: string | null;
  readonly mode: "react" | "standard" | "plan_execute";
  readonly enabled: boolean;
  readonly independent_execution: boolean;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface McpServerTable {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly transport_type: "stdio" | "sse" | "streamable" | "http";
  readonly config: JsonColumn;
  readonly version: string | null;
  readonly auto_connect: boolean;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface McpSecurityPolicyTable {
  readonly id: string;
  readonly allowed_server_names: JsonColumn;
  readonly max_tool_output_length: number;
  readonly allowed_stdio_commands: JsonColumn;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface ScheduledJobTable {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly cron_expression: string;
  readonly timezone: string;
  readonly job_type: "mcp_tool" | "agent";
  readonly mcp_server_name: string | null;
  readonly tool_name: string | null;
  readonly tool_arguments: JsonColumn;
  readonly agent_prompt: string | null;
  readonly persona_id: string | null;
  readonly agent_system_prompt: string | null;
  readonly agent_model: string | null;
  readonly agent_max_tool_calls: number | null;
  readonly tags: JsonColumn;
  readonly notification_channel_id: string | null;
  readonly webhook_url: string | null;
  readonly retry_on_failure: boolean;
  readonly max_retry_count: number;
  readonly execution_timeout_ms: number | null;
  readonly enabled: boolean;
  readonly last_run_at: NullableTimestamp;
  readonly last_status: "success" | "failed" | "running" | "skipped" | null;
  readonly last_result: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}

export interface ScheduledJobExecutionTable {
  readonly id: string;
  readonly job_id: string;
  readonly job_name: string;
  readonly status: "success" | "failed" | "running" | "skipped";
  readonly result: string | null;
  readonly duration_ms: number;
  readonly dry_run: boolean;
  readonly started_at: Timestamp;
  readonly completed_at: NullableTimestamp;
  readonly created_at: Timestamp;
}

export interface ScheduledJobLockTable {
  readonly job_id: string;
  readonly owner_id: string;
  readonly locked_until: Timestamp;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
}
