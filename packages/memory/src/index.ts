import type { ModelMessage, ModelToolCall } from "@muse/model";

import type { CompactionFailureReason } from "./compaction-telemetry.js";
import type { UserModel, UserModelSlot } from "./user-model-slots.js";

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
  /**
   * Context Engineering Phase 5: when set, the trim's old-history
   * pass scores each removable message via `scoreMessageImportance`
   * and prefers removing the lowest-scoring ones first, so
   * multi-day task state survives longer than casual chat.
   *
   * `"temporal"` (default) — legacy oldest-first.
   * `"importance"` — score-aware. Messages above
   * `importanceThreshold` are preserved when possible; the
   * remaining-budget pressure can still force removal of high-score
   * messages to honour the hard cap.
   */
  readonly compactionStrategy?: "temporal" | "importance";
  readonly importanceThreshold?: number;
  readonly importanceContext?: {
    readonly activeTaskId?: string;
    readonly activeTaskTitle?: string;
    readonly currentFocus?: string;
  };
  /**
   * Plumbing only — `trimConversationMessages` itself does not read this
   * field; it exists so a caller can carry a per-session/per-turn focus
   * topic (e.g. a chat `/compact <topic>` request) alongside the rest of
   * the trim config and forward it to `summarizeDroppedContext`'s
   * `focusTopic` option when a compaction fires and an aux summarizer is
   * configured. Unset ⇒ no focus directive, byte-identical behavior.
   */
  readonly focusTopic?: string;
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
  /**
   * The messages COMPACTED AWAY this pass (present in the input, absent
   * from `messages`). Empty when nothing was dropped. Enables an
   * auxiliary-model summary of the dropped window (CMP-2,
   * `summarizeDroppedContext`) without re-deriving the diff at the call
   * site. Reference-identity diff: a message kept-but-repaired (e.g. a
   * pruned tool-call) may appear here — harmless for summarization.
   */
  readonly dropped: readonly ConversationMessage[];
  /**
   * Bucketed reason the trim under-delivered — still over the hard budget
   * after every pass, or dropped messages without crossing the summary
   * threshold. `undefined` on a clean run (including a no-op). See
   * `compaction-telemetry.ts` for the classification.
   */
  readonly compactionFailureReason?: CompactionFailureReason;
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
  /**
   * Owning user. Used by `listAll` to scope episodic-recall searches
   * so user A doesn't surface user B's prior sessions. Optional —
   * legacy rows that pre-date the 0002 migration leave it undefined.
   */
  readonly userId?: string;
}

export interface ConversationSummaryListOptions {
  /** Only return summaries owned by this user. Omit to return any owner. */
  readonly userId?: string;
  /** Cap on returned rows. Default 200. Sort: newest `updatedAt` first. */
  readonly limit?: number;
}

export interface ConversationSummaryStore {
  get(sessionId: string): Awaitable<ConversationSummary | undefined>;
  save(summary: ConversationSummary): Awaitable<ConversationSummary>;
  delete(sessionId: string): Awaitable<boolean>;
  /**
   * Optional: list saved summaries newest-first, optionally filtered by
   * user. Stores that pre-date the 0002 migration may omit this — the
   * episodic-recall provider falls back to "no recall" when missing.
   */
  listAll?(options?: ConversationSummaryListOptions): Awaitable<readonly ConversationSummary[]>;
}

export const DEFAULT_CACHE_KEY_MAX_CHARS = 2_000;
export const DEFAULT_TOKEN_CACHE_MAX_ENTRIES = 50_000;
export const DEFAULT_TOKEN_CACHE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_MESSAGE_STRUCTURE_OVERHEAD = 20;
/**
 * Per-tool-call wire-envelope overhead, in tokens, ON TOP of the
 * tool name + serialized arguments. A provider tool_use / tool_result
 * block carries structural keys (`type`, `id`, `name`, role wrapper)
 * that the raw name+args string does not. Counting only name+args
 * undercounts a turn that fires several tools in parallel — N tool
 * calls share a SINGLE message overhead today, so the budget silently
 * over-fills and trimming triggers too late. Adding this per call
 * makes multi-tool turns count honestly.
 */
export const DEFAULT_TOOL_CALL_ENVELOPE_OVERHEAD = 8;
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
  defaultConversationSummaryFile,
  FileConversationSummaryStore,
  InMemoryConversationSummaryStore,
  KyselyConversationSummaryStore,
  mapConversationSummaryRow
} from "./memory-conversation-summary-store.js";

// Salient-fact extraction for compaction detail-retention
// (arXiv:2511.17208 — verbatim-substring, no generation, trust-boundary).
export {
  extractSalientFacts,
  mergeSalientFacts,
  parseKeyDetailsBlock,
  renderKeyDetailsBlock,
  stripKeyDetailsBlock
} from "./salient-facts.js";

// Fail-close post-compaction quality gate for the OPTIONAL aux-LLM summary
// (hermes/openclaw-inspired safeguard) — deterministic anchor-coverage check,
// never a second model call.
export {
  DEFAULT_ANCHOR_COVERAGE_RATIO,
  extractCompactionAnchors,
  verifyCompactionSummaryQuality,
  type CompactionAnchor,
  type CompactionQualityGateOptions,
  type CompactionQualityGateResult
} from "./compaction-quality-gate.js";

// Message importance scoring.
export {
  IMPORTANCE_DEFAULT_THRESHOLD,
  recencyBonus,
  scoreMessageContent,
  scoreMessageImportance,
  type ImportanceContext
} from "./message-importance.js";

// Context Engineering D5: tool-output importance scoring.
export {
  applyToolOutputImportance,
  scaleToolOutputBudget,
  scoreToolOutputImportance
} from "./tool-output-importance.js";

// Deterministic 1-line semantic summary of a tool result, folded
// into the truncation marker so a compacted tool result still shows
// what it did (shows-its-work). Pure, code-derived, no LLM.
export {
  summarizeToolResult,
  type ToolResultSummaryOptions
} from "./tool-output-summary.js";

// Stale inline-image stripping: drop multi-MB base64 image bytes from
// turns before the current one (re-shipped every turn otherwise).
export {
  stripStaleImageAttachments,
  type StripStaleImagesResult
} from "./media-strip.js";


export interface KyselyTaskMemoryStoreOptions {
  readonly now?: () => Date;
  readonly retentionMs?: number;
}

/**
 * One superseded fact value, retained when `upsertFact` overwrites an
 * existing key with a DIFFERENT value — so Muse keeps temporal depth
 * ("you moved from Busan to Seoul on …") instead of silently dropping
 * the prior value. Bounded by `MAX_FACT_HISTORY_ENTRIES`.
 */
export interface FactSupersession {
  readonly key: string;
  readonly previousValue: string;
  readonly replacedAt: Date;
  /**
   * How the new value relates to {@link previousValue}: a `refine`
   * (elaboration/narrowing — "Seoul" → "Seoul, Gangnam-gu") vs a
   * `contradict` (a genuine value flip — "Seoul" → "Busan"), set by
   * `classifyValueChange` in `collectFactSupersessions`. Optional for
   * back-compat: a legacy entry written before this field existed has it
   * absent, and a consumer treats absent as the conservative "changed"
   * framing.
   */
  readonly kind?: "refine" | "contradict";
  /**
   * Which namespace the superseded value lived in. Absent = `fact`
   * (back-compat: every entry written before this field was a fact change).
   * A `preference` entry records a change to a preference / veto / goal, so a
   * "what Muse learned about you" surface can cover those too and resolve the
   * current value from the right store.
   */
  readonly scope?: "fact" | "preference";
}

export interface UserMemory {
  readonly userId: string;
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: Date;
  /**
   * Append-only log of overwritten fact values (newest last, capped).
   * Optional for the same reason as `userModel`: the Kysely store has
   * no column for it yet, so the server path leaves it absent while
   * the file + in-memory daily-driver stores populate it.
   */
  readonly factHistory?: readonly FactSupersession[];
  /**
   * Typed user-model slots (Context Engineering 1.c, rounds 162-164).
   * Optional so legacy callers and the Kysely store (which doesn't
   * yet have a `user_model_json` column) keep working untouched.
   * When set, `buildPersonaSnapshot` composes the typed segments
   * alongside the legacy `facts` / `preferences` records.
   */
  readonly userModel?: UserModel;
}

export interface UserMemoryStore {
  findByUserId(userId: string): Awaitable<UserMemory | undefined>;
  /**
   * Persist a fact for the user. Implementations MUST pipe `value`
   * through `sanitizeUserMemoryValue` before persistence so a
   * compromised auto-extract hook can't smuggle ANSI / control bytes
   * or oversized blobs into the persona-expansion path that gets
   * re-emitted into future system prompts.
   */
  upsertFact(userId: string, key: string, value: string): Awaitable<UserMemory>;
  /** Same sanitisation contract as upsertFact. */
  upsertPreference(userId: string, key: string, value: string): Awaitable<UserMemory>;
  deleteByUserId(userId: string): Awaitable<boolean>;
  /**
   * Remove a single remembered key from `facts` and/or `preferences`
   * (whichever holds it), leaving the rest of the user's memory intact.
   * Returns whether anything was removed. Optional: stores that don't
   * implement it (e.g. legacy Kysely) signal "forget unsupported" by
   * leaving it undefined, and callers feature-detect — same pattern as
   * `upsertUserModelSlot`. This backs the in-chat `/forget` control so a
   * personal assistant can be told to drop one thing without wiping all.
   * `kind` scopes the delete to one namespace (facts OR preferences) — the
   * auto-extractor passes it so a FACT retraction can't wipe a same-key
   * PREFERENCE; omitting it keeps the dual-delete for the explicit `/forget`.
   */
  forget?(userId: string, key: string, kind?: "fact" | "preference"): Awaitable<boolean>;
  /**
   * Optional typed-slot upsert. When the store implements it, callers
   * can write structured `UserModel` slots; replace-by-id semantics
   * (slot.id is the key within the slot's `kind`). Stores that return
   * `undefined` for this method should be treated as not supporting
   * typed slots — callers fall back to `upsertFact` / `upsertPreference`.
   */
  upsertUserModelSlot?(userId: string, slot: UserModelSlot): Awaitable<UserMemory>;
}


// User-memory persistence (InMemory + Kysely stores, row mappers,
// cloneUserMemory helper) lives in packages/memory/src/memory-user-store.ts.
export {
  createUserMemoryInsert,
  InMemoryUserMemoryStore,
  KyselyUserMemoryStore,
  classifyMemoryOperation,
  mapUserMemoryRow,
  MAX_USER_MEMORY_VALUE_CHARS,
  normalizeMemoryKey,
  sanitizeUserMemoryValue,
  type MemoryOperation
} from "./memory-user-store.js";

export {
  classifyFactFreshness,
  classifyValueChange,
  contestedFactKeys,
  defaultBeliefProvenanceFile,
  deriveFactProvenance,
  keysWithActiveRetraction,
  recordRetraction,
  refinementAwareDistinctValueCount,
  FileBeliefProvenanceStore,
  MAX_BELIEF_PROVENANCE_ENTRIES,
  provisionalFactKeys,
  readBeliefProvenance,
  beliefValueTimeline,
  formatFirstLearned,
  selectPromotableFacts,
  selectRecentlyForgotten,
  selectRecentlyLearnedFacts,
  selectVolatileBeliefs,
  staleFactKeys,
  writeBeliefProvenance,
  type BeliefProvenance,
  type BeliefProvenanceStore,
  type FactFreshness,
  type FactProvenance,
  type BeliefValueStep,
  type PromotableFact,
  type RecentlyForgotten,
  type RecentlyLearnedFact,
  type VolatileBelief
} from "./belief-provenance-store.js";

// File-backed UserMemoryStore — the JARVIS-class persistent layer for
// the daily-driver path that doesn't run Postgres. `~/.muse/user-memory.json`
// keyed by userId.
export {
  FileUserMemoryStore,
  type FileUserMemoryStoreOptions
} from "./memory-user-store-file.js";
export {
  decryptMemoryEnvelope,
  encryptMemoryEnvelope,
  isEncryptedMemoryEnvelope,
  memoryEncryptionSecret,
  type EncryptedMemoryEnvelope
} from "./memory-encryption.js";



// Task-memory persistence + quality validation lives in
// packages/memory/src/memory-task-store.ts.
export {
  assertTaskMemoryQuality,
  buildActiveTaskMemoryQuery,
  buildTaskMemoryUpsertQuery,
  createTaskMemoryInsert,
  defaultTaskMemoryFile,
  evaluateTaskMemoryQuality,
  FileTaskMemoryStore,
  InMemoryTaskMemoryStore,
  KyselyTaskMemoryStore,
  mapTaskMemoryRow,
  TaskMemoryQualityError
} from "./memory-task-store.js";

// Token estimator + conversation trimming primitives live in
// packages/memory/src/memory-token-trim.ts.
export {
  COMPACTION_RESUME_DIRECTIVE,
  computeApproximateTokens,
  createApproximateTokenEstimator,
  estimateConversationTokens,
  trimConversationMessages
} from "./memory-token-trim.js";

export { classifyCompactionFailure } from "./compaction-telemetry.js";
export type { CompactionFailureInput, CompactionFailureStatusLike } from "./compaction-telemetry.js";
export type { CompactionFailureReason };

export {
  chunkDroppedOnToolPairs,
  DEFAULT_CHUNK_MAX_CHARS,
  summarizeDroppedContext,
  summarizeDroppedContextInStages
} from "./context-aux-summary.js";
export type {
  DroppedContextSummarizer,
  DroppedContextSummarizerOptions,
  SummarizeDroppedOptions
} from "./context-aux-summary.js";

// Tool-output trimming primitive (Context Engineering
// step 1.b). Used by agent-core/model-loop to cap individual tool
// results before they land as messages.
export {
  trimToolOutput,
  type ToolOutputTrimOptions,
  type ToolOutputTrimResult
} from "./memory-tool-output-trim.js";

// In-process content-by-reference store (Context
// Engineering step 1.d foundation). Tools that return large
// content can stash the original here under a short id; the
// agent fetches expanded content via the `muse.context` MCP
// server when needed.
export {
  InMemoryContextReferenceStore,
  type ContextReference,
  type ContextReferenceStore,
  type InMemoryContextReferenceStoreOptions
} from "./context-reference-store.js";

// Stale tool-observation masking (The Complexity Trap
// arXiv:2508.21433 + ACON arXiv:2510.00615). Rewrites prior turns'
// tool messages to a re-fetchable placeholder so multi-turn context
// stops growing without dropping any source.
export {
  maskStaleToolObservations,
  type MaskStaleToolObservationsOptions,
  type MaskStaleToolObservationsResult
} from "./observation-mask.js";

// Typed user-model slots (Context Engineering step
// 1.c foundation). Parallel structure to the legacy free-text
// `Record<string,string>` facts/preferences. Persistence + runtime
// wiring lands in subsequent iters.
export {
  actrActivation,
  consolidationPlan,
  DEFAULT_CONSOLIDATION_MIN_INTERVAL_MS,
  DEFAULT_CONSOLIDATION_MIN_NEW_HITS,
  planMemoryConsolidationTick,
  recallActivation,
  scoreRecallHit,
  selectForgettable,
  selectPromotableMemories,
  shouldConsolidateMemory,
  type ConsolidationPlan,
  type ConsolidationScheduleInput,
  type ForgettingMemory,
  type MemoryConsolidationTickResult,
  type MemoryConsolidationTickState,
  type PromotedMemory,
  type RecallHitLike,
  type SelectForgettableOptions,
  type SelectPromotableOptions
} from "./recall-promotion.js";

export {
  DEFAULT_CONFIDENCE_HALF_LIFE_DAYS,
  DEFAULT_RECONFIRM_BELOW,
  EMPTY_USER_MODEL,
  composeUserModelSnapshot,
  effectiveConfidence,
  removeUserModelSlot,
  selectReconfirmableSlots,
  upsertUserModelSlot,
  type ReconfirmOptions,
  type UserGoalSlot,
  type UserModel,
  type UserModelComposeOptions,
  type UserModelSlot,
  type UserModelSlotBase,
  type UserPreferenceSlot,
  type UserScheduleSlot,
  type UserVetoSlot
} from "./user-model-slots.js";

export {
  createUserMemoryAutoExtractHook,
  dropModelAssertedValues,
  extractJsonObject,
  pickAutoExtractSystemPrompt,
  readSkipAutoExtract,
  type ExtractionPayload,
  type UserMemoryAutoExtractOptions
} from "./memory-auto-extract.js";

// Pattern detection — `docs/design/pattern-detection.md` steps 1+2.
// Signal aggregator + category-1 time-of-day-action detector. Later
// steps add the weekly-task detector and the proactive integration.
export {
  aggregateActivitySignals,
  type ActivityEventSignal,
  type AggregateActivitySignalsOptions,
  type NoteMtimeSignal,
  type PatternSignals,
  type TaskSignal
} from "./pattern-signals.js";
export {
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  type DetectTimeOfDayPatternsOptions,
  type DetectWeeklyTaskPatternsOptions,
  type HourBand,
  type PatternMatch,
  type TimeOfDayMatch,
  type Weekday,
  type WeeklyTaskMatch
} from "./pattern-detector.js";
export {
  detectLapsedPatterns,
  nextOccurrenceMs,
  predictUpcomingNeeds,
  selectFireablePatterns,
  type CooldownRecordLike,
  type DetectLapsedPatternsOptions,
  type LapsedPattern,
  type PredictedNeed,
  type PredictUpcomingNeedsOptions,
  type SelectFireablePatternsOptions
} from "./pattern-orchestration.js";

// Deterministic "what Muse recently learned about you" projection over the
// append-only factHistory (learning-surfacing). Code — not the model — selects
// what to surface, and every item cites its recorded supersession.
export { formatLearnedConfirmation, projectRecentlyLearned, renderRecentlyLearnedLines, selectNewSupersessions, summarizeRecentlyLearned, type RecentlyLearnedItem } from "./recently-learned.js";

// Bounded deterministic query identifier for the recall-hits sidecar — fuels
// selectPromotableMemories's minUniqueQueries gate.
export { hashQuery, normalizeQueryForHash } from "./query-hash.js";


