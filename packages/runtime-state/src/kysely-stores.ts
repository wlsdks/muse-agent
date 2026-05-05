import type { MuseDatabase, CheckpointTable, HookTraceTable, PendingApprovalTable } from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import type {
  ApprovalContext,
  ApprovalStatus,
  ApprovalSummary,
  CheckpointStore,
  ExecutionCheckpoint,
  HookTrace,
  HookTraceStore,
  PendingApprovalStore,
  RecordHookTraceInput,
  RequestApprovalInput,
  Reversibility,
  SaveCheckpointInput,
  ToolApprovalResponse
} from "./index.js";

type CheckpointRow = Selectable<CheckpointTable>;
type HookTraceRow = Selectable<HookTraceTable>;
type HookTraceInsert = Insertable<HookTraceTable>;
type PendingApprovalRow = Selectable<PendingApprovalTable>;
type PendingApprovalInsert = Insertable<PendingApprovalTable>;
type CheckpointInsert = Insertable<CheckpointTable>;

export interface KyselyCheckpointStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface KyselyPendingApprovalStoreOptions {
  readonly defaultTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface KyselyHookTraceStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class KyselyCheckpointStore implements CheckpointStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyCheckpointStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("checkpoint"));
    this.now = options.now ?? (() => new Date());
  }

  async save(input: SaveCheckpointInput): Promise<ExecutionCheckpoint> {
    const row = await buildCheckpointUpsertQuery(this.db, input, {
      idFactory: this.idFactory,
      now: this.now
    }).executeTakeFirstOrThrow();

    return mapCheckpointRow(row);
  }

  async findByRunId(runId: string): Promise<readonly ExecutionCheckpoint[]> {
    const rows = await this.db
      .selectFrom("checkpoints")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("step", "asc")
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(mapCheckpointRow);
  }

  async findLatestByRunId(runId: string): Promise<ExecutionCheckpoint | undefined> {
    const row = await this.db
      .selectFrom("checkpoints")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("step", "desc")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapCheckpointRow(row) : undefined;
  }

  async deleteByRunId(runId: string): Promise<void> {
    await this.db.deleteFrom("checkpoints").where("run_id", "=", runId).execute();
  }
}

export class KyselyPendingApprovalStore implements PendingApprovalStore {
  static readonly defaultTimeoutMs = 300_000;
  static readonly defaultPollIntervalMs = 500;

  private readonly defaultTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyPendingApprovalStoreOptions = {}
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? KyselyPendingApprovalStore.defaultTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? KyselyPendingApprovalStore.defaultPollIntervalMs;
    this.idFactory = options.idFactory ?? (() => createRunId("approval"));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? sleep;
  }

  async requestApproval(input: RequestApprovalInput): Promise<ToolApprovalResponse> {
    const request = createPendingApprovalInsert(input, {
      defaultTimeoutMs: this.defaultTimeoutMs,
      idFactory: this.idFactory,
      now: this.now
    });

    await this.db.insertInto("pending_approvals").values(request).executeTakeFirstOrThrow();
    return this.waitForDecision(request.id, request.timeout_ms);
  }

  async listPending(): Promise<readonly ApprovalSummary[]> {
    const rows = await buildPendingApprovalsQuery(this.db).execute();

    return rows.map(mapPendingApprovalRow);
  }

  async listPendingByUser(userId: string): Promise<readonly ApprovalSummary[]> {
    const rows = await buildPendingApprovalsQuery(this.db, userId).execute();

    return rows.map(mapPendingApprovalRow);
  }

  async countPending(): Promise<number> {
    return this.countPendingRows();
  }

  async countPendingByUser(userId: string): Promise<number> {
    return this.countPendingRows(userId);
  }

  async approve(approvalId: string, modifiedArguments?: JsonObject): Promise<boolean> {
    const row = await buildApprovalDecisionQuery(this.db, approvalId, "approved", {
      modifiedArguments,
      now: this.now
    }).executeTakeFirst();

    return Boolean(row);
  }

  async reject(approvalId: string, reason = "Rejected by human"): Promise<boolean> {
    const row = await buildApprovalDecisionQuery(this.db, approvalId, "rejected", {
      now: this.now,
      reason
    }).executeTakeFirst();

    return Boolean(row);
  }

  private async waitForDecision(approvalId: string, timeoutMs: number): Promise<ToolApprovalResponse> {
    const deadline = this.now().getTime() + timeoutMs;

    while (this.now().getTime() < deadline) {
      const row = await this.findApprovalRow(approvalId);

      if (!row) {
        return { approved: false, reason: "Approval request disappeared before it was resolved" };
      }

      if (row.status !== "pending") {
        return mapApprovalResponse(row);
      }

      await this.sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.now().getTime())));
    }

    return this.expirePendingApproval(approvalId, timeoutMs);
  }

  private async findApprovalRow(approvalId: string): Promise<PendingApprovalRow | undefined> {
    return this.db
      .selectFrom("pending_approvals")
      .selectAll()
      .where("id", "=", approvalId)
      .executeTakeFirst();
  }

  private async expirePendingApproval(approvalId: string, timeoutMs: number): Promise<ToolApprovalResponse> {
    const reason = `Approval timed out after ${timeoutMs}ms`;
    const row = await buildApprovalDecisionQuery(this.db, approvalId, "expired", {
      now: this.now,
      reason
    }).executeTakeFirst();

    if (row) {
      return mapApprovalResponse(row);
    }

    const latest = await this.findApprovalRow(approvalId);
    return latest && latest.status !== "pending" ? mapApprovalResponse(latest) : { approved: false, reason };
  }

  private async countPendingRows(userId?: string): Promise<number> {
    let query = this.db
      .selectFrom("pending_approvals")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "=", "pending");

    if (userId !== undefined) {
      query = query.where("user_id", "=", userId);
    }

    const row = await query.executeTakeFirst();
    return Number(row?.count ?? 0);
  }
}

export class KyselyHookTraceStore implements HookTraceStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyHookTraceStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("hook_trace"));
    this.now = options.now ?? (() => new Date());
  }

  async record(input: RecordHookTraceInput): Promise<HookTrace> {
    const row = await this.db
      .insertInto("hook_traces")
      .values(createHookTraceInsert(input, {
        idFactory: this.idFactory,
        now: this.now
      }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapHookTraceRow(row);
  }

  async listByRunId(runId: string): Promise<readonly HookTrace[]> {
    const rows = await this.db
      .selectFrom("hook_traces")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("started_at", "asc")
      .orderBy("created_at", "asc")
      .execute();

    return rows.map(mapHookTraceRow);
  }

  async listRecent(limit = 100): Promise<readonly HookTrace[]> {
    const rows = await this.db
      .selectFrom("hook_traces")
      .selectAll()
      .orderBy("started_at", "desc")
      .orderBy("created_at", "desc")
      .limit(Math.max(0, limit))
      .execute();

    return rows.map(mapHookTraceRow);
  }
}

export function buildCheckpointUpsertQuery(
  db: Kysely<MuseDatabase>,
  input: SaveCheckpointInput,
  options: Required<KyselyCheckpointStoreOptions>
) {
  const row = createCheckpointInsert(input, options);

  return db
    .insertInto("checkpoints")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["run_id", "step"]).doUpdateSet({
        created_at: row.created_at,
        id: row.id,
        state: row.state
      })
    )
    .returningAll();
}

export function buildPendingApprovalsQuery(db: Kysely<MuseDatabase>, userId?: string) {
  let query = db
    .selectFrom("pending_approvals")
    .selectAll()
    .where("status", "=", "pending")
    .orderBy("requested_at", "desc");

  if (userId !== undefined) {
    query = query.where("user_id", "=", userId);
  }

  return query;
}

export function buildApprovalDecisionQuery(
  db: Kysely<MuseDatabase>,
  approvalId: string,
  status: Exclude<ApprovalStatus, "pending" | "cancelled">,
  options: {
    readonly modifiedArguments?: JsonObject;
    readonly now: () => Date;
    readonly reason?: string;
  }
) {
  return db
    .updateTable("pending_approvals")
    .set({
      modified_arguments: options.modifiedArguments ?? {},
      reason: options.reason ?? null,
      resolved_at: options.now(),
      status
    })
    .where("id", "=", approvalId)
    .where("status", "=", "pending")
    .returningAll();
}

export function createCheckpointInsert(
  input: SaveCheckpointInput,
  options: Required<KyselyCheckpointStoreOptions>
): CheckpointInsert {
  return {
    created_at: input.createdAt ?? options.now(),
    id: input.id ?? options.idFactory(),
    run_id: input.runId,
    state: input.state,
    step: input.step
  };
}

export function createPendingApprovalInsert(
  input: RequestApprovalInput,
  options: Required<Pick<KyselyPendingApprovalStoreOptions, "defaultTimeoutMs" | "idFactory" | "now">>
): PendingApprovalInsert {
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : options.defaultTimeoutMs;

  return {
    arguments: input.arguments,
    context: input.context ? approvalContextToJsonObject(input.context) : {},
    id: options.idFactory(),
    modified_arguments: {},
    reason: null,
    requested_at: options.now(),
    resolved_at: null,
    run_id: input.runId,
    status: "pending",
    timeout_ms: timeoutMs,
    tool_name: input.toolName,
    user_id: input.userId
  };
}

export function createHookTraceInsert(
  input: RecordHookTraceInput,
  options: Required<KyselyHookTraceStoreOptions>
): HookTraceInsert {
  const startedAt = input.startedAt ?? options.now();
  const completedAt = input.completedAt ?? options.now();

  return {
    completed_at: completedAt,
    created_at: input.createdAt ?? options.now(),
    duration_ms: input.durationMs ?? Math.max(0, completedAt.getTime() - startedAt.getTime()),
    error: input.error ?? null,
    hook_id: input.hookId,
    id: input.id ?? options.idFactory(),
    lifecycle: input.lifecycle,
    metadata: input.metadata ?? {},
    run_id: input.runId,
    started_at: startedAt,
    status: input.status
  };
}

function approvalContextToJsonObject(context: ApprovalContext): JsonObject {
  return {
    ...(context.reason ? { reason: context.reason } : {}),
    ...(context.action ? { action: context.action } : {}),
    ...(context.impactScope ? { impactScope: context.impactScope } : {}),
    ...(context.reversibility ? { reversibility: context.reversibility } : {})
  };
}

export function mapCheckpointRow(row: CheckpointRow): ExecutionCheckpoint {
  return {
    createdAt: toDate(row.created_at),
    id: row.id,
    runId: row.run_id,
    state: toJsonObject(row.state),
    step: row.step
  };
}

export function mapPendingApprovalRow(row: PendingApprovalRow): ApprovalSummary {
  return {
    arguments: toJsonObject(row.arguments),
    context: toApprovalContext(row.context),
    id: row.id,
    requestedAt: toDate(row.requested_at),
    runId: row.run_id,
    status: row.status,
    timeoutMs: row.timeout_ms,
    toolName: row.tool_name,
    userId: row.user_id
  };
}

export function mapHookTraceRow(row: HookTraceRow): HookTrace {
  return {
    completedAt: toDate(row.completed_at),
    createdAt: toDate(row.created_at),
    durationMs: row.duration_ms,
    ...(row.error ? { error: row.error } : {}),
    hookId: row.hook_id,
    id: row.id,
    lifecycle: row.lifecycle,
    metadata: toJsonObject(row.metadata),
    runId: row.run_id,
    startedAt: toDate(row.started_at),
    status: row.status
  };
}

export function mapApprovalResponse(row: PendingApprovalRow): ToolApprovalResponse {
  if (row.status === "approved") {
    const modifiedArguments = toJsonObject(row.modified_arguments);

    return Object.keys(modifiedArguments).length > 0
      ? { approved: true, modifiedArguments }
      : { approved: true };
  }

  return {
    approved: false,
    reason: row.reason ?? `Approval ${row.status}`
  };
}

function toApprovalContext(value: JsonValue): ApprovalContext {
  const object = toJsonObject(value);
  const reversibility = asReversibility(object.reversibility);

  return {
    ...(typeof object.reason === "string" ? { reason: object.reason } : {}),
    ...(typeof object.action === "string" ? { action: object.action } : {}),
    ...(typeof object.impactScope === "string" ? { impactScope: object.impactScope } : {}),
    ...(reversibility ? { reversibility } : {})
  };
}

function toJsonObject(value: JsonValue): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asReversibility(value: JsonValue | undefined): Reversibility | undefined {
  return value === "reversible" ||
    value === "partially_reversible" ||
    value === "irreversible" ||
    value === "unknown"
    ? value
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
