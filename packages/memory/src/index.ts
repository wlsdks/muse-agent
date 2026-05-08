import type { MuseDatabase } from "@muse/db";
import type { ModelMessage, ModelToolCall } from "@muse/model";
import type { Insertable, Kysely } from "kysely";

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
}

export interface ConversationTrimResult {
  readonly messages: readonly ConversationMessage[];
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
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
export const COMPACTION_SUMMARY_PREFIX = "[Conversation summary";
export const COMPACTION_PINNED_ENTITIES_PREFIX = "Pinned entities for pronoun resolution";
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

export class InMemoryTaskMemoryStore implements TaskMemoryStore, TaskMemoryMaintenance {
  private readonly tasks = new Map<string, RequiredTaskState>();
  private readonly activeTaskBySession = new Map<string, string>();
  private readonly maxTasks: number;
  private readonly retentionMs: number;

  constructor(options: { readonly maxTasks?: number; readonly retentionMs?: number } = {}) {
    this.maxTasks = Math.max(1, options.maxTasks ?? 10_000);
    this.retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_TASK_MEMORY_RETENTION_MS);
  }

  save(state: TaskState): void {
    assertTaskMemoryQuality(state);
    const normalized = normalizeTaskState(state);
    this.tasks.set(normalized.taskId, normalized);

    if (isActiveLike(normalized.status)) {
      this.activeTaskBySession.set(sessionKey(normalized.sessionId, normalized.userId), normalized.taskId);

      if (!normalized.userId) {
        this.activeTaskBySession.set(sessionKey(normalized.sessionId), normalized.taskId);
      }
    } else {
      this.removeActiveIndexFor(normalized.taskId);
    }

    this.trimOldest();
  }

  findById(taskId: string): TaskState | undefined {
    const state = this.tasks.get(taskId);

    if (!state || this.isExpired(state, new Date())) {
      if (state) {
        this.clear(taskId);
      }

      return undefined;
    }

    return state;
  }

  findActiveBySession(sessionId: string, userId?: string): TaskState | undefined {
    const ids = [
      userId ? this.activeTaskBySession.get(sessionKey(sessionId, userId)) : undefined,
      this.activeTaskBySession.get(sessionKey(sessionId))
    ].filter((value): value is string => Boolean(value));

    for (const id of ids) {
      const state = this.findById(id);

      if (state && isActiveLike(state.status ?? "active") && isVisibleTo(state, userId)) {
        return state;
      }
    }

    return undefined;
  }

  clear(taskId: string): void {
    this.tasks.delete(taskId);
    this.removeActiveIndexFor(taskId);
  }

  purgeExpired(now = new Date()): number {
    const ids = [...this.tasks.values()]
      .filter((state) => this.isExpired(state, now))
      .map((state) => state.taskId);

    for (const id of ids) {
      this.clear(id);
    }

    return ids.length;
  }

  purgeTerminalOlderThan(cutoff: Date): number {
    const ids = [...this.tasks.values()]
      .filter((state) => !isActiveLike(state.status) && state.updatedAt < cutoff)
      .map((state) => state.taskId);

    for (const id of ids) {
      this.clear(id);
    }

    return ids.length;
  }

  private isExpired(state: RequiredTaskState, now: Date): boolean {
    return state.updatedAt.getTime() + this.retentionMs <= now.getTime();
  }

  private trimOldest(): void {
    while (this.tasks.size > this.maxTasks) {
      const oldest = [...this.tasks.values()].sort((left, right) =>
        left.updatedAt.getTime() - right.updatedAt.getTime()
      )[0];

      if (!oldest) {
        return;
      }

      this.clear(oldest.taskId);
    }
  }

  private removeActiveIndexFor(taskId: string): void {
    for (const [key, value] of this.activeTaskBySession) {
      if (value === taskId) {
        this.activeTaskBySession.delete(key);
      }
    }
  }
}

export class TaskMemoryQualityError extends Error {
  readonly report: TaskMemoryQualityReport;

  constructor(report: TaskMemoryQualityReport) {
    super(`Task memory quality gate failed: ${report.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message)
      .join("; ")}`);
    this.name = "TaskMemoryQualityError";
    this.report = report;
  }
}

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

type TaskMemoryRow = Record<string, unknown>;
type TaskMemoryInsert = Insertable<MuseDatabase["task_memories"]>;

export class KyselyTaskMemoryStore implements TaskMemoryStore, TaskMemoryMaintenance {
  private readonly now: () => Date;
  private readonly retentionMs: number;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyTaskMemoryStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_TASK_MEMORY_RETENTION_MS);
  }

  async save(state: TaskState): Promise<void> {
    await buildTaskMemoryUpsertQuery(this.db, state, {
      now: this.now,
      retentionMs: this.retentionMs
    }).executeTakeFirstOrThrow();
  }

  async findById(taskId: string): Promise<TaskState | undefined> {
    const row = await this.db
      .selectFrom("task_memories")
      .selectAll()
      .where("task_id", "=", taskId)
      .where((eb) => eb.or([
        eb("expires_at", "is", null),
        eb("expires_at", ">", this.now())
      ]))
      .executeTakeFirst();

    return row ? mapTaskMemoryRow(row as TaskMemoryRow) : undefined;
  }

  async findActiveBySession(sessionId: string, userId?: string): Promise<TaskState | undefined> {
    const userScoped = userId
      ? await buildActiveTaskMemoryQuery(this.db, sessionId, userId).executeTakeFirst()
      : undefined;

    if (userScoped) {
      return mapTaskMemoryRow(userScoped as TaskMemoryRow);
    }

    const sessionScoped = await buildActiveTaskMemoryQuery(this.db, sessionId).executeTakeFirst();
    return sessionScoped ? mapTaskMemoryRow(sessionScoped as TaskMemoryRow) : undefined;
  }

  async clear(taskId: string): Promise<void> {
    await this.db.deleteFrom("task_memories").where("task_id", "=", taskId).execute();
  }

  async purgeExpired(now = this.now()): Promise<number> {
    const result = await this.db
      .deleteFrom("task_memories")
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", now)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }

  async purgeTerminalOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom("task_memories")
      .where("status", "not in", ["active", "blocked"])
      .where("updated_at", "<", cutoff)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  }
}

export function buildTaskMemoryUpsertQuery(
  db: Kysely<MuseDatabase>,
  state: TaskState,
  options: {
    readonly now: () => Date;
    readonly retentionMs: number;
  }
) {
  const insert = createTaskMemoryInsert(state, options);

  return db
    .insertInto("task_memories")
    .values(insert)
    .onConflict((oc) => oc.column("task_id").doUpdateSet({
      blockers_json: insert.blockers_json,
      decisions_json: insert.decisions_json,
      expires_at: insert.expires_at,
      goal: insert.goal,
      metadata_json: insert.metadata_json,
      plan_json: insert.plan_json,
      session_id: insert.session_id,
      status: insert.status,
      updated_at: insert.updated_at,
      user_id: insert.user_id
    }))
    .returningAll();
}

export function buildActiveTaskMemoryQuery(db: Kysely<MuseDatabase>, sessionId: string, userId?: string) {
  let query = db
    .selectFrom("task_memories")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("status", "in", ["active", "blocked"])
    .orderBy("updated_at", "desc")
    .limit(1);

  query = userId ? query.where("user_id", "=", userId) : query.where("user_id", "is", null);
  return query;
}

export function createTaskMemoryInsert(
  state: TaskState,
  options: {
    readonly now: () => Date;
    readonly retentionMs: number;
  }
): TaskMemoryInsert {
  assertTaskMemoryQuality(state);
  const normalized = normalizeTaskState(state);
  const expiresAt = new Date(normalized.updatedAt.getTime() + options.retentionMs);

  return {
    blockers_json: [...normalized.blockers],
    created_at: normalized.createdAt,
    decisions_json: [...normalized.decisions],
    expires_at: expiresAt,
    goal: normalized.goal,
    metadata_json: { ...normalized.metadata },
    plan_json: [...normalized.plan],
    session_id: normalized.sessionId,
    status: normalized.status,
    task_id: normalized.taskId,
    updated_at: normalized.updatedAt,
    user_id: normalized.userId ?? null
  };
}

export function evaluateTaskMemoryQuality(state: TaskState): TaskMemoryQualityReport {
  const issues: TaskMemoryQualityIssue[] = [];

  if (!state.taskId.trim()) {
    issues.push(taskMemoryQualityIssue("missing_task_id", "Task memory requires a non-empty taskId", "error"));
  }

  if (!state.sessionId.trim()) {
    issues.push(taskMemoryQualityIssue("missing_session_id", "Task memory requires a non-empty sessionId", "error"));
  }

  if (!state.goal.trim()) {
    issues.push(taskMemoryQualityIssue("missing_goal", "Task memory requires a non-empty goal", "error"));
  }

  for (const item of state.plan ?? []) {
    if (!item.step.trim()) {
      issues.push(taskMemoryQualityIssue("empty_plan_step", "Task memory plan items require non-empty steps", "error"));
    }
  }

  for (const decision of state.decisions ?? []) {
    if (!decision.summary.trim()) {
      issues.push(taskMemoryQualityIssue(
        "empty_decision_summary",
        "Task memory decisions require non-empty summaries",
        "error"
      ));
    }
  }

  for (const blocker of state.blockers ?? []) {
    if (!blocker.description.trim()) {
      issues.push(taskMemoryQualityIssue(
        "empty_blocker_description",
        "Task memory blockers require non-empty descriptions",
        "error"
      ));
    }
  }

  if ((state.status ?? "active") === "blocked" && (state.blockers ?? []).length === 0) {
    issues.push(taskMemoryQualityIssue(
      "blocked_without_blocker",
      "Blocked task memory should include at least one blocker",
      "warning"
    ));
  }

  if (state.status === "completed" && (state.decisions ?? []).length === 0 && (state.plan ?? []).length === 0) {
    issues.push(taskMemoryQualityIssue(
      "completed_without_evidence",
      "Completed task memory should include decisions or plan evidence",
      "warning"
    ));
  }

  const summary = {
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length
  };

  return {
    issues,
    ok: summary.errorCount === 0,
    summary
  };
}

export function assertTaskMemoryQuality(state: TaskState): void {
  const report = evaluateTaskMemoryQuality(state);

  if (!report.ok) {
    throw new TaskMemoryQualityError(report);
  }
}

function taskMemoryQualityIssue(
  code: TaskMemoryQualityIssueCode,
  message: string,
  severity: TaskMemoryQualitySeverity
): TaskMemoryQualityIssue {
  return { code, message, severity };
}

export function mapTaskMemoryRow(row: TaskMemoryRow): TaskState {
  const userId = nullableString(row.user_id);

  return {
    blockers: jsonArray<TaskBlocker>(row.blockers_json),
    createdAt: dateValue(row.created_at),
    decisions: jsonArray<TaskDecision>(row.decisions_json),
    goal: stringValue(row.goal),
    metadata: jsonRecord(row.metadata_json),
    plan: jsonArray<TaskPlanItem>(row.plan_json),
    sessionId: stringValue(row.session_id),
    status: taskStatusValue(row.status),
    taskId: stringValue(row.task_id),
    updatedAt: dateValue(row.updated_at),
    ...(userId ? { userId } : {})
  };
}

type RequiredTaskState = Omit<
  Required<TaskState>,
  "blockers" | "decisions" | "metadata" | "plan" | "userId"
> & {
  readonly blockers: readonly TaskBlocker[];
  readonly decisions: readonly TaskDecision[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly plan: readonly TaskPlanItem[];
  readonly userId?: string;
};

function normalizeTaskState(state: TaskState): RequiredTaskState {
  const now = new Date();
  return {
    blockers: state.blockers ?? [],
    createdAt: state.createdAt ?? now,
    decisions: state.decisions ?? [],
    goal: state.goal,
    metadata: state.metadata ?? {},
    plan: state.plan ?? [],
    sessionId: state.sessionId,
    status: state.status ?? "active",
    taskId: state.taskId,
    updatedAt: state.updatedAt ?? state.createdAt ?? now,
    ...(state.userId ? { userId: state.userId } : {})
  };
}

function sessionKey(sessionId: string, userId?: string): string {
  return userId && userId.length > 0 ? `${sessionId}::${userId}` : sessionId;
}

function isActiveLike(status: TaskStatus): boolean {
  return status === "active" || status === "blocked";
}

function isVisibleTo(state: TaskState, userId: string | undefined): boolean {
  return !userId || !state.userId || state.userId === userId;
}

// Token estimator + conversation trimming primitives live in
// packages/memory/src/memory-token-trim.ts.
export {
  computeApproximateTokens,
  createApproximateTokenEstimator,
  estimateConversationTokens,
  trimConversationMessages
} from "./memory-token-trim.js";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(typeof value === "string" ? value : 0);
}

function taskStatusValue(value: unknown): TaskStatus {
  return value === "blocked" || value === "completed" || value === "cancelled" ? value : "active";
}

function jsonArray<T>(value: unknown): readonly T[] {
  if (Array.isArray(value)) {
    return value as readonly T[];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed as readonly T[] : [];
    } catch {
      return [];
    }
  }

  return [];
}

function jsonRecord(value: unknown): Readonly<Record<string, string>> {
  if (isStringRecord(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isStringRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

function jsonStringRecord(value: unknown): Readonly<Record<string, string>> {
  return jsonRecord(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}


