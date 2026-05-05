import type { JsonValue, RunStatus } from "@muse/shared";
import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type NumericString = ColumnType<string, string | number | undefined, string | number>;
type JsonColumn<T extends JsonValue = JsonValue> = ColumnType<T, T | string | undefined, T | string>;

export interface MuseDatabase {
  readonly agent_runs: AgentRunTable;
  readonly agent_specs: AgentSpecTable;
  readonly checkpoints: CheckpointTable;
  readonly conversation_messages: ConversationMessageTable;
  readonly pending_approvals: PendingApprovalTable;
  readonly runtime_settings: RuntimeSettingTable;
  readonly tool_calls: ToolCallTable;
  readonly trace_events: TraceEventTable;
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
