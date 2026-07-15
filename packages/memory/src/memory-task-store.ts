/**
 * Task-memory persistence + quality validation primitives.
 *
 * Owns `InMemoryTaskMemoryStore` (in-process map keyed by `taskId`,
 * plus a session+user activeTask index, with `purgeExpired` /
 * `purgeTerminalOlderThan` maintenance) and `KyselyTaskMemoryStore`
 * (Postgres `INSERT … ON CONFLICT (task_id) DO UPDATE` upsert with
 * `expires_at` retention windowing). Plus the row-builder, the
 * `evaluateTaskMemoryQuality` validator (errors on missing
 * taskId/sessionId/goal + empty plan steps + empty
 * decision/blocker entries; warnings on `blocked` without blocker
 * and `completed` without evidence), the `assertTaskMemoryQuality`
 * throwing wrapper that raises `TaskMemoryQualityError`, the
 * `mapTaskMemoryRow` row mapper, and the `buildTaskMemoryUpsertQuery`
 * + `buildActiveTaskMemoryQuery` SQL builders.
 *
 * Re-exported from the memory barrel for backwards compatibility.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { MuseDatabase } from "@muse/db";
import type { Insertable, Kysely } from "kysely";
import type {
  KyselyTaskMemoryStoreOptions,
  TaskBlocker,
  TaskDecision,
  TaskMemoryMaintenance,
  TaskMemoryQualityIssue,
  TaskMemoryQualityIssueCode,
  TaskMemoryQualityReport,
  TaskMemoryQualitySeverity,
  TaskMemoryStore,
  TaskPlanItem,
  TaskState,
  TaskStatus
} from "./index.js";
import { DEFAULT_TASK_MEMORY_RETENTION_MS } from "./index.js";

type TaskMemoryRow = Record<string, unknown>;
type TaskMemoryInsert = Insertable<MuseDatabase["task_memories"]>;

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

  /** All currently-held task states (read-only snapshot) — lets a file-backed
   *  wrapper persist the result after delegating an operation here. */
  entries(): readonly TaskState[] {
    return [...this.tasks.values()];
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

interface SerializedTaskState {
  readonly taskId: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly userId?: string;
  readonly status?: string;
  readonly plan: readonly { readonly step: string; readonly status?: string; readonly updatedAt?: string }[];
  readonly decisions: readonly { readonly summary: string; readonly reason?: string; readonly decidedAt?: string }[];
  readonly blockers: readonly { readonly description: string; readonly owner?: string; readonly createdAt?: string }[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function serializeTaskState(s: TaskState): SerializedTaskState {
  return {
    blockers: (s.blockers ?? []).map((b) => ({ description: b.description, ...(b.owner ? { owner: b.owner } : {}), ...(b.createdAt ? { createdAt: b.createdAt.toISOString() } : {}) })),
    createdAt: (s.createdAt ?? new Date()).toISOString(),
    decisions: (s.decisions ?? []).map((d) => ({ summary: d.summary, ...(d.reason ? { reason: d.reason } : {}), ...(d.decidedAt ? { decidedAt: d.decidedAt.toISOString() } : {}) })),
    goal: s.goal,
    metadata: s.metadata ?? {},
    plan: (s.plan ?? []).map((p) => ({ step: p.step, ...(p.status ? { status: p.status } : {}), ...(p.updatedAt ? { updatedAt: p.updatedAt.toISOString() } : {}) })),
    sessionId: s.sessionId,
    taskId: s.taskId,
    updatedAt: (s.updatedAt ?? s.createdAt ?? new Date()).toISOString(),
    ...(s.status ? { status: s.status } : {}),
    ...(s.userId ? { userId: s.userId } : {})
  };
}

function deserializeTaskState(r: SerializedTaskState): TaskState {
  return {
    blockers: (r.blockers ?? []).map((b): TaskBlocker => ({ description: b.description, ...(b.owner ? { owner: b.owner } : {}), ...(b.createdAt ? { createdAt: new Date(b.createdAt) } : {}) })),
    decisions: (r.decisions ?? []).map((d): TaskDecision => ({ summary: d.summary, ...(d.reason ? { reason: d.reason } : {}), ...(d.decidedAt ? { decidedAt: new Date(d.decidedAt) } : {}) })),
    goal: r.goal,
    plan: (r.plan ?? []).map((p): TaskPlanItem => ({ step: p.step, ...(p.status ? { status: p.status as TaskPlanItem["status"] } : {}), ...(p.updatedAt ? { updatedAt: new Date(p.updatedAt) } : {}) })),
    sessionId: r.sessionId,
    taskId: r.taskId,
    ...(r.metadata ? { metadata: r.metadata } : {}),
    ...(r.status ? { status: r.status as TaskStatus } : {}),
    ...(r.userId ? { userId: r.userId } : {}),
    ...(r.createdAt ? { createdAt: new Date(r.createdAt) } : {}),
    ...(r.updatedAt ? { updatedAt: new Date(r.updatedAt) } : {})
  };
}

export function defaultTaskMemoryFile(): string {
  const fromEnv = process.env.MUSE_TASK_MEMORY_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "task-memory.json");
}

async function readTaskStates(file: string): Promise<readonly TaskState[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return []; // corrupt ⇒ empty, never throw (task recall is best-effort)
  }
  const list = parsed && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown }).tasks)
    ? (parsed as { tasks: SerializedTaskState[] }).tasks
    : [];
  return list.filter((entry) => entry && typeof entry.taskId === "string" && entry.taskId.length > 0).map(deserializeTaskState);
}

async function writeTaskStates(file: string, tasks: readonly TaskState[]): Promise<void> {
  const payload = `${JSON.stringify({ tasks: tasks.map(serializeTaskState) }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * File-backed task-memory store — like the conversation-summary store, the CLI
 * has no Postgres, so without this it falls back to `InMemoryTaskMemoryStore`,
 * which is empty at the start of every `muse ask`/`chat` PROCESS — in-progress
 * task state (goal/plan/decisions/blockers) never survives between invocations.
 * Delegates ALL semantics (normalize, active-session index, retention/expiry,
 * trim) to a freshly-hydrated `InMemoryTaskMemoryStore` and persists its entries
 * after each op, so the file is the only added surface. Dates (top-level +
 * nested plan/decisions/blockers) round-trip via ISO. Mirrors
 * `FileConversationSummaryStore`.
 */
export class FileTaskMemoryStore implements TaskMemoryStore, TaskMemoryMaintenance {
  private static readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly file: string;
  private readonly options: { readonly maxTasks?: number; readonly retentionMs?: number };
  constructor(options: { readonly file?: string; readonly maxTasks?: number; readonly retentionMs?: number } = {}) {
    this.file = options.file && options.file.trim().length > 0 ? options.file : defaultTaskMemoryFile();
    this.options = {
      ...(options.maxTasks !== undefined ? { maxTasks: options.maxTasks } : {}),
      ...(options.retentionMs !== undefined ? { retentionMs: options.retentionMs } : {})
    };
  }

  private async hydrate(): Promise<InMemoryTaskMemoryStore> {
    const mem = new InMemoryTaskMemoryStore(this.options);
    for (const task of await readTaskStates(this.file)) {
      mem.save(task); // rebuilds the active-session index + honours retention/trim; normalize preserves stored dates
    }
    return mem;
  }

  async save(state: TaskState): Promise<void> {
    await this.mutate((mem) => mem.save(state));
  }

  async findById(taskId: string): Promise<TaskState | undefined> {
    return this.mutate((mem) => mem.findById(taskId)); // may clear an expired task as a side effect
  }

  async findActiveBySession(sessionId: string, userId?: string): Promise<TaskState | undefined> {
    return this.mutate((mem) => mem.findActiveBySession(sessionId, userId));
  }

  async clear(taskId: string): Promise<void> {
    await this.mutate((mem) => mem.clear(taskId));
  }

  async purgeExpired(now?: Date): Promise<number> {
    return this.mutate((mem) => now ? mem.purgeExpired(now) : mem.purgeExpired());
  }

  async purgeTerminalOlderThan(cutoff: Date): Promise<number> {
    return this.mutate((mem) => mem.purgeTerminalOlderThan(cutoff));
  }

  private async mutate<T>(operation: (memory: InMemoryTaskMemoryStore) => T | Promise<T>): Promise<T> {
    return this.serializeWrite(async () => {
      const memory = await this.hydrate();
      const result = await operation(memory);
      await writeTaskStates(this.file, memory.entries());
      return result;
    });
  }

  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const prior = FileTaskMemoryStore.writeQueues.get(this.file) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    FileTaskMemoryStore.writeQueues.set(this.file, next);

    try {
      return await next;
    } finally {
      if (FileTaskMemoryStore.writeQueues.get(this.file) === next) {
        FileTaskMemoryStore.writeQueues.delete(this.file);
      }
    }
  }
}

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

function taskMemoryQualityIssue(
  code: TaskMemoryQualityIssueCode,
  message: string,
  severity: TaskMemoryQualitySeverity
): TaskMemoryQualityIssue {
  return { code, message, severity };
}

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

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}
