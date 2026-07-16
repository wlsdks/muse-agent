/**
 * Scheduled-job and scheduled-execution store implementations extracted
 * from packages/scheduler/src/index.ts.
 *
 * Four classes covering the in-memory and Kysely-backed variants of
 * `ScheduledJobStore` + `ScheduledJobExecutionStore`. The in-memory
 * stores enforce eviction caps (`defaultMaxJobs` / `defaultMaxExecutions`)
 * and run synchronously; the Kysely stores async over PostgreSQL.
 *
 * Validation/normalization helpers (`normalizeScheduledJob` /
 * `normalizeScheduledJobExecution` / `createScheduledJobInsert` /
 * `createScheduledJobUpdate` / `createScheduledJobExecutionInsert` /
 * `mapScheduledJobRow` / `mapScheduledJobExecutionRow`) and the
 * `SchedulerValidationError` class still live in the main scheduler
 * barrel; this module imports them.
 */

import type { MuseDatabase, ScheduledJobExecutionTable, ScheduledJobTable } from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Kysely, Selectable } from "kysely";

import {
  SchedulerValidationError,
  compareJobs,
  createScheduledJobExecutionInsert,
  createScheduledJobInsert,
  createScheduledJobUpdate,
  mapScheduledJobExecutionRow,
  mapScheduledJobRow,
  normalizeScheduledJob,
  normalizeScheduledJobExecution,
  type InMemoryScheduledJobExecutionStoreOptions,
  type InMemoryScheduledJobStoreOptions,
  type JobExecutionStatus,
  type KyselyScheduledJobExecutionStoreOptions,
  type KyselyScheduledJobStoreOptions,
  type ScheduledJob,
  type ScheduledJobExecution,
  type ScheduledJobExecutionInput,
  type ScheduledJobExecutionStore,
  type ScheduledJobInput,
  type ScheduledJobUpdateInput,
  type ScheduledJobStore
} from "./index.js";

type ScheduledJobRow = Selectable<ScheduledJobTable>;
type ScheduledJobExecutionRow = Selectable<ScheduledJobExecutionTable>;

const defaultMaxJobs = 1_000;
const defaultMaxExecutions = 200;
const resultTruncationLimit = 5_000;

export class InMemoryScheduledJobStore implements ScheduledJobStore {
  private readonly idFactory: () => string;
  private readonly maxJobs: number;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, ScheduledJob>();

  constructor(options: InMemoryScheduledJobStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("scheduled_job"));
    this.maxJobs = Math.max(1, options.maxJobs ?? defaultMaxJobs);
    this.now = options.now ?? (() => new Date());
  }

  list(): readonly ScheduledJob[] {
    return [...this.jobs.values()].sort(compareJobs);
  }

  findById(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  findByName(name: string): ScheduledJob | undefined {
    return [...this.jobs.values()].find((job) => job.name === name);
  }

  save(input: ScheduledJobInput): ScheduledJob {
    if (this.findByName(input.name)) {
      throw new SchedulerValidationError(`Scheduled job already exists: ${input.name}`);
    }

    const saved = normalizeScheduledJob(input, {
      id: input.id ?? this.idFactory(),
      now: this.now
    });

    this.jobs.set(saved.id, saved);
    this.evictOverflow();
    return saved;
  }

  update(id: string, input: ScheduledJobUpdateInput): ScheduledJob | undefined {
    const existing = this.jobs.get(id);

    if (!existing) {
      return undefined;
    }

    const duplicate = this.findByName(input.name);

    if (duplicate && duplicate.id !== id) {
      throw new SchedulerValidationError(`Scheduled job already exists: ${input.name}`);
    }

    const updated = normalizeScheduledJob(
      {
        ...input,
        id,
        createdAt: existing.createdAt,
        lastResult: existing.lastResult,
        lastRunAt: existing.lastRunAt,
        lastStatus: existing.lastStatus
      },
      { id, now: this.now }
    );

    this.jobs.set(id, updated);
    return updated;
  }

  delete(id: string): void {
    this.jobs.delete(id);
  }

  /**
   * Bulk-load already-normalized jobs verbatim — no name-dedup check, no id
   * generation, no re-validation. The hydration path for a file-backed
   * wrapper (`FileScheduledJobStore`) reading its own previously-written
   * JSON, where re-running `save`'s duplicate-name guard would throw on a
   * perfectly valid persisted pair. NOT for untrusted/external input.
   */
  restore(jobs: readonly ScheduledJob[]): void {
    this.jobs.clear();

    for (const job of jobs) {
      this.jobs.set(job.id, job);
    }

    this.evictOverflow();
  }

  updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): void {
    const existing = this.jobs.get(id);

    if (!existing) {
      return;
    }

    this.jobs.set(id, {
      ...existing,
      lastResult: result ? result.slice(0, resultTruncationLimit) : undefined,
      lastRunAt: this.now(),
      lastStatus: status,
      updatedAt: this.now()
    });
  }

  private evictOverflow(): void {
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.list()[0];

      if (!oldest) {
        return;
      }

      this.jobs.delete(oldest.id);
    }
  }
}

export class InMemoryScheduledJobExecutionStore implements ScheduledJobExecutionStore {
  private readonly idFactory: () => string;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly executions: ScheduledJobExecution[] = [];

  constructor(options: InMemoryScheduledJobExecutionStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("scheduled_execution"));
    this.maxEntries = Math.max(1, options.maxEntries ?? defaultMaxExecutions);
    this.now = options.now ?? (() => new Date());
  }

  save(input: ScheduledJobExecutionInput): ScheduledJobExecution {
    const saved = normalizeScheduledJobExecution(input, {
      id: input.id ?? this.idFactory(),
      now: this.now
    });

    this.executions.unshift(saved);

    while (this.executions.length > this.maxEntries) {
      this.executions.pop();
    }

    return saved;
  }

  findByJobId(jobId: string, limit = 20): readonly ScheduledJobExecution[] {
    return this.executions.filter((execution) => execution.jobId === jobId).slice(0, Math.max(0, limit));
  }

  findRecent(limit = 50): readonly ScheduledJobExecution[] {
    return this.executions.slice(0, Math.max(0, limit));
  }

  deleteOldestExecutions(jobId: string, keepCount: number): void {
    const keep = Math.max(0, keepCount);
    const jobExecutions = this.executions.filter((execution) => execution.jobId === jobId);
    const removeIds = new Set(jobExecutions.slice(keep).map((execution) => execution.id));

    if (removeIds.size === 0) {
      return;
    }

    for (let index = this.executions.length - 1; index >= 0; index -= 1) {
      const execution = this.executions[index];

      if (execution && removeIds.has(execution.id)) {
        this.executions.splice(index, 1);
      }
    }
  }
}

export class KyselyScheduledJobStore implements ScheduledJobStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyScheduledJobStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("scheduled_job"));
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly ScheduledJob[]> {
    const rows = await buildScheduledJobListQuery(this.db).execute();
    return rows.map(mapScheduledJobRow);
  }

  async findById(id: string): Promise<ScheduledJob | undefined> {
    const row = await this.db.selectFrom("scheduled_jobs").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapScheduledJobRow(row) : undefined;
  }

  async findByName(name: string): Promise<ScheduledJob | undefined> {
    const row = await this.db.selectFrom("scheduled_jobs").selectAll().where("name", "=", name).executeTakeFirst();
    return row ? mapScheduledJobRow(row) : undefined;
  }

  async save(input: ScheduledJobInput): Promise<ScheduledJob> {
    const insert = createScheduledJobInsert(input, {
      idFactory: this.idFactory,
      now: this.now
    });

    await this.db.insertInto("scheduled_jobs").values(insert).execute();
    return mapScheduledJobRow(insert as ScheduledJobRow);
  }

  async update(id: string, input: ScheduledJobUpdateInput): Promise<ScheduledJob | undefined> {
    const existing = await this.findById(id);

    if (!existing) {
      return undefined;
    }

    const update = createScheduledJobUpdate(input, existing, this.now);

    await this.db.updateTable("scheduled_jobs").set(update).where("id", "=", id).execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("scheduled_jobs").where("id", "=", id).execute();
  }

  async updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): Promise<void> {
    await this.db
      .updateTable("scheduled_jobs")
      .set({
        last_result: result ? result.slice(0, resultTruncationLimit) : null,
        last_run_at: this.now(),
        last_status: status,
        updated_at: this.now()
      })
      .where("id", "=", id)
      .execute();
  }
}

/**
 * The list query lifted out as an exported helper so a unit test
 * can introspect the compiled SQL without lifting a real Postgres.
 * The InMemory store's `compareJobs` comparator sorts by createdAt
 * ASC then name ASC; this query must produce the same ordering so
 * a same-timestamp tie comes back in a deterministic, stable order
 * across implementations (closes the in-memory/Kysely parity gap).
 */
export function buildScheduledJobListQuery(db: Kysely<MuseDatabase>) {
  return db
    .selectFrom("scheduled_jobs")
    .selectAll()
    .orderBy("created_at", "asc")
    .orderBy("name", "asc");
}

export class KyselyScheduledJobExecutionStore implements ScheduledJobExecutionStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyScheduledJobExecutionStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("scheduled_execution"));
    this.now = options.now ?? (() => new Date());
  }

  async save(input: ScheduledJobExecutionInput): Promise<ScheduledJobExecution> {
    const insert = createScheduledJobExecutionInsert(input, {
      idFactory: this.idFactory,
      now: this.now
    });

    await this.db.insertInto("scheduled_job_executions").values(insert).execute();
    return mapScheduledJobExecutionRow(insert as ScheduledJobExecutionRow);
  }

  async findByJobId(jobId: string, limit = 20): Promise<readonly ScheduledJobExecution[]> {
    const rows = await this.db
      .selectFrom("scheduled_job_executions")
      .selectAll()
      .where("job_id", "=", jobId)
      .orderBy("started_at", "desc")
      .limit(Math.max(0, limit))
      .execute();
    return rows.map(mapScheduledJobExecutionRow);
  }

  async findRecent(limit = 50): Promise<readonly ScheduledJobExecution[]> {
    const rows = await this.db
      .selectFrom("scheduled_job_executions")
      .selectAll()
      .orderBy("started_at", "desc")
      .limit(Math.max(0, limit))
      .execute();
    return rows.map(mapScheduledJobExecutionRow);
  }

  async deleteOldestExecutions(jobId: string, keepCount: number): Promise<void> {
    const rows = await this.db
      .selectFrom("scheduled_job_executions")
      .select("id")
      .where("job_id", "=", jobId)
      .orderBy("started_at", "desc")
      .offset(Math.max(0, keepCount))
      .execute();
    const ids = rows.map((row) => row.id);

    if (ids.length === 0) {
      return;
    }

    await this.db.deleteFrom("scheduled_job_executions").where("id", "in", ids).execute();
  }
}
