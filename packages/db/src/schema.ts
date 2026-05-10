import type { JsonValue, RunStatus } from "@muse/shared";
import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type NumericString = ColumnType<string, string | number | undefined, string | number>;
type JsonColumn<T extends JsonValue = JsonValue> = ColumnType<T, T | string | undefined, T | string>;
type CompatibilityTable = Record<string, ColumnType<unknown, unknown, unknown>>;

export interface MuseDatabase {
  readonly agent_runs: AgentRunTable;
  readonly agent_specs: AgentSpecTable;
  readonly checkpoints: CheckpointTable;
  readonly conversation_messages: ConversationMessageTable;
  readonly conversation_summaries: ConversationSummaryTable;
  readonly debug_replay_captures: DebugReplayCaptureTable;
  readonly hook_traces: HookTraceTable;
  readonly mcp_security_policy: McpSecurityPolicyTable;
  readonly mcp_servers: McpServerTable;
  readonly metric_token_usage: MetricTokenUsageTable;
  readonly runtime_settings: RuntimeSettingTable;
  readonly scheduled_job_executions: ScheduledJobExecutionTable;
  readonly scheduled_job_locks: ScheduledJobLockTable;
  readonly scheduled_jobs: ScheduledJobTable;
  readonly session_tags: SessionTagTable;
  readonly task_memories: CompatibilityTable;
  readonly tool_calls: ToolCallTable;
  readonly trace_events: TraceEventTable;
  readonly user_memories: UserMemoryTable;
  readonly users: UserTable;
}

export interface DebugReplayCaptureTable {
  readonly id: ColumnType<string, string | undefined, string>;
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

export interface UserTable {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly password_hash: string;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
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

export interface UserMemoryTable {
  readonly user_id: string;
  readonly facts: JsonColumn;
  readonly preferences: JsonColumn;
  readonly recent_topics: string;
  readonly updated_at: Timestamp;
  /**
   * Typed user-model slots (Context Engineering 1.c, round 165).
   * Stored as JSONB so the runtime can evolve the slot taxonomy
   * without further migrations. Nullable — old rows that pre-date
   * this column have no typed slots, which the @muse/memory layer
   * treats as `userModel: undefined`.
   */
  readonly user_model: JsonColumn<JsonValue | null>;
}

export interface SessionTagTable {
  readonly id: string;
  readonly session_id: string;
  readonly label: string;
  readonly comment: string | null;
  readonly created_by: string;
  readonly created_at: number;
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

export interface MetricTokenUsageTable {
  readonly time: Timestamp;
  readonly run_id: string;
  readonly model: string;
  readonly provider: string;
  readonly step_type: string;
  readonly prompt_tokens: number;
  readonly prompt_cached_tokens: number;
  readonly completion_tokens: number;
  readonly reasoning_tokens: number;
  readonly total_tokens: number;
  readonly estimated_cost_usd: NumericString;
}
