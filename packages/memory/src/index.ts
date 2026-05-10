import type { ModelMessage, ModelToolCall } from "@muse/model";

export interface TokenEstimator {
  estimate(text: string): number;
}

export interface TokenEstimatorOptions {
  readonly cacheKeyMaxChars?: number;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

export interface ConversationMessage extends ModelMessage {
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ConversationTrimOptions {
  readonly maxContextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly systemPrompt?: string;
  readonly toolTokenReserve?: number;
  readonly estimator?: TokenEstimator;
  readonly messageStructureOverhead?: number;
  readonly compactionThreshold?: number;
  readonly insertSummary?: boolean;
  /**
   * Soft "working budget" in tokens. When set and the conversation
   * exceeds this threshold (even though it's still within
   * `maxContextWindowTokens` minus reserves), trim proactively to
   * the working budget rather than waiting until the hard cap is
   * hit. This is the "compaction at threshold" pattern from
   * Anthropic's effective-context-engineering guidance — quality
   * degrades well before the nominal window is full (NoLiMa), so
   * a working budget around 40% of the nominal context typically
   * keeps long sessions coherent.
   *
   * When unset, falls back to the legacy hard-cap-only behavior so
   * existing callers see no change.
   */
  readonly workingBudgetTokens?: number;
  /**
   * Optional pre-resolved persona / user-model snapshot. When the
   * trim fires (working_budget OR hard_limit) and the compaction
   * summary is inserted, this snapshot becomes a `[User context]`
   * block in the summary so the agent doesn't lose what it had
   * learned about the user across the boundary.
   *
   * Caller responsibilities:
   *   - Resolve the snapshot synchronously (e.g. from a
   *     UserMemoryStore in autoconfigure / agent-core).
   *   - Keep it short — it competes for the same budget. A few
   *     hundred tokens of structured key=value lines is the
   *     intended shape, not a full memory dump.
   *   - Treat it as untrusted: snapshot text should not contain
   *     instructions the agent could mistake for system prompts.
   *
   * When unset OR the trim doesn't fire, no `[User context]`
   * block is added (the prompt stays as-is so non-compacted runs
   * pay zero overhead for the feature).
   */
  readonly personaSnapshot?: string;
}

export interface ConversationTrimResult {
  readonly messages: readonly ConversationMessage[];
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
  /**
   * Which threshold caused the trim, if any. Useful for observability
   * — distinguishes a proactive compaction (`working_budget`) from a
   * forced one (`hard_limit`) and a no-op (`none`).
   */
  readonly triggeredBy: "none" | "working_budget" | "hard_limit";
}

type Awaitable<T> = T | Promise<T>;

export type TaskStatus = "active" | "blocked" | "completed" | "cancelled";
export type TaskPlanItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TaskPlanItem {
  readonly step: string;
  readonly status?: TaskPlanItemStatus;
  readonly updatedAt?: Date;
}

export interface TaskDecision {
  readonly summary: string;
  readonly reason?: string;
  readonly decidedAt?: Date;
}

export interface TaskBlocker {
  readonly description: string;
  readonly owner?: string;
  readonly createdAt?: Date;
}

export interface TaskState {
  readonly taskId: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly goal: string;
  readonly status?: TaskStatus;
  readonly plan?: readonly TaskPlanItem[];
  readonly decisions?: readonly TaskDecision[];
  readonly blockers?: readonly TaskBlocker[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export type TaskMemoryQualityIssueCode =
  | "missing_task_id"
  | "missing_session_id"
  | "missing_goal"
  | "empty_plan_step"
  | "empty_decision_summary"
  | "empty_blocker_description"
  | "blocked_without_blocker"
  | "completed_without_evidence";

export type TaskMemoryQualitySeverity = "error" | "warning";

export interface TaskMemoryQualityIssue {
  readonly code: TaskMemoryQualityIssueCode;
  readonly message: string;
  readonly severity: TaskMemoryQualitySeverity;
}

export interface TaskMemoryQualityReport {
  readonly issues: readonly TaskMemoryQualityIssue[];
  readonly ok: boolean;
  readonly summary: {
    readonly errorCount: number;
    readonly warningCount: number;
  };
}

export interface TaskMemoryStore {
  save(state: TaskState): Awaitable<void>;
  findById(taskId: string): Awaitable<TaskState | undefined>;
  findActiveBySession(sessionId: string, userId?: string): Awaitable<TaskState | undefined>;
  clear(taskId: string): Awaitable<void>;
}

export interface TaskMemoryMaintenance {
  purgeExpired(now?: Date): Awaitable<number>;
  purgeTerminalOlderThan(cutoff: Date): Awaitable<number>;
}

export type FactCategory = "ENTITY" | "DECISION" | "CONDITION" | "STATE" | "NUMERIC" | "GENERAL";

export interface StructuredFact {
  readonly key: string;
  readonly value: string;
  readonly category?: FactCategory;
  readonly extractedAt?: Date;
}

export interface ConversationSummary {
  readonly sessionId: string;
  readonly narrative: string;
  readonly facts?: readonly StructuredFact[];
  readonly summarizedUpToIndex: number;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface ConversationSummaryStore {
  get(sessionId: string): Awaitable<ConversationSummary | undefined>;
  save(summary: ConversationSummary): Awaitable<ConversationSummary>;
  delete(sessionId: string): Awaitable<boolean>;
}

export const DEFAULT_CACHE_KEY_MAX_CHARS = 2_000;
export const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 50_000;
export const DEFAULT_TOKEN_CACHE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_MESSAGE_STRUCTURE_OVERHEAD = 20;
export const DEFAULT_COMPACTION_THRESHOLD = 3;
/**
 * Suggested ratio for `workingBudgetTokens` when callers don't set
 * an explicit value (Anthropic's effective-context-engineering
 * guidance + NoLiMa context-rot research converge on ~30-50% of the
 * nominal window for the soft trigger). Exported so consumers can
 * compute `Math.floor(maxContextWindowTokens * DEFAULT_WORKING_BUDGET_RATIO)`
 * without re-deriving the constant.
 */
export const DEFAULT_WORKING_BUDGET_RATIO = 0.4;
export const COMPACTION_SUMMARY_PREFIX = "[Conversation summary";
export const COMPACTION_PINNED_ENTITIES_PREFIX = "Pinned entities for pronoun resolution";
/**
 * Prefix for the persona / user-model snapshot block appended to
 * compaction summaries. Stable string so future tooling can detect
 * + strip it during further trimming if needed.
 */
export const COMPACTION_PERSONA_SNAPSHOT_PREFIX = "User context";
export const DEFAULT_TASK_MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

// Conversation-summary persistence (in-memory + Kysely stores, upsert
// query builder, row builder + mapper, structured-fact serializer
// pair) lives in packages/memory/src/memory-conversation-summary-store.ts.
export {
  buildConversationSummaryUpsertQuery,
  createConversationSummaryInsert,
  InMemoryConversationSummaryStore,
  KyselyConversationSummaryStore,
  mapConversationSummaryRow
} from "./memory-conversation-summary-store.js";


export interface KyselyTaskMemoryStoreOptions {
  readonly now?: () => Date;
  readonly retentionMs?: number;
}

export interface UserMemory {
  readonly userId: string;
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: Date;
}

export interface UserMemoryStore {
  findByUserId(userId: string): Awaitable<UserMemory | undefined>;
  upsertFact(userId: string, key: string, value: string): Awaitable<UserMemory>;
  upsertPreference(userId: string, key: string, value: string): Awaitable<UserMemory>;
  deleteByUserId(userId: string): Awaitable<boolean>;
}


// User-memory persistence (InMemory + Kysely stores, row mappers,
// cloneUserMemory helper) lives in packages/memory/src/memory-user-store.ts.
export {
  createUserMemoryInsert,
  InMemoryUserMemoryStore,
  KyselyUserMemoryStore,
  mapUserMemoryRow
} from "./memory-user-store.js";



// Task-memory persistence + quality validation lives in
// packages/memory/src/memory-task-store.ts.
export {
  assertTaskMemoryQuality,
  buildActiveTaskMemoryQuery,
  buildTaskMemoryUpsertQuery,
  createTaskMemoryInsert,
  evaluateTaskMemoryQuality,
  InMemoryTaskMemoryStore,
  KyselyTaskMemoryStore,
  mapTaskMemoryRow,
  TaskMemoryQualityError
} from "./memory-task-store.js";

// Token estimator + conversation trimming primitives live in
// packages/memory/src/memory-token-trim.ts.
export {
  computeApproximateTokens,
  createApproximateTokenEstimator,
  estimateConversationTokens,
  trimConversationMessages
} from "./memory-token-trim.js";

export {
  createUserMemoryAutoExtractHook,
  type UserMemoryAutoExtractOptions
} from "./memory-auto-extract.js";


