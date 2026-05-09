import type { MuseDatabase, CheckpointTable, HookTraceTable } from "@muse/db";
import { createRunId, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import type {
  CheckpointStore,
  ExecutionCheckpoint,
  HookTrace,
  HookTraceStore,
  RecordHookTraceInput,
  SaveCheckpointInput
} from "./index.js";

type CheckpointRow = Selectable<CheckpointTable>;
type HookTraceRow = Selectable<HookTraceTable>;
type HookTraceInsert = Insertable<HookTraceTable>;
type CheckpointInsert = Insertable<CheckpointTable>;

export interface KyselyCheckpointStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
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

export function mapCheckpointRow(row: CheckpointRow): ExecutionCheckpoint {
  return {
    createdAt: toDate(row.created_at),
    id: row.id,
    runId: row.run_id,
    state: toJsonObject(row.state),
    step: row.step
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

function toJsonObject(value: JsonValue): import("@muse/shared").JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as import("@muse/shared").JsonObject;
  }

  return {};
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
