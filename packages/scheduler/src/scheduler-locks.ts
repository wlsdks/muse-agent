/**
 * Distributed scheduler lock primitives extracted from
 * packages/scheduler/src/index.ts.
 *
 * Owns three `DistributedSchedulerLock` implementations:
 *
 *   - `NoOpDistributedSchedulerLock`: always-acquired, single-instance
 *     dev / test fallback.
 *   - `InMemoryDistributedSchedulerLock`: process-local Map keyed by
 *     `jobId`, owner-scoped release, TTL-bounded acquire that respects
 *     the prior owner's `lockedUntil`.
 *   - `KyselyDistributedSchedulerLock`: PostgreSQL-backed lock that
 *     uses `INSERT … ON CONFLICT (job_id) DO UPDATE … WHERE locked_until
 *     <= now OR owner_id = self` so only one pod claims the slot per
 *     TTL window. Lock release deletes only rows owned by the current
 *     instance.
 *
 * Plus the `createScheduledJobLockInsert` row builder used by the
 * Kysely lock and the `InMemorySchedulerLockEntry` private type.
 *
 * Re-exported from the scheduler barrel for backwards compatibility.
 */

import type { MuseDatabase, ScheduledJobLockTable } from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Insertable, Kysely } from "kysely";
import type {
  DistributedSchedulerLock,
  InMemoryDistributedSchedulerLockOptions,
  KyselyDistributedSchedulerLockOptions
} from "./index.js";

type ScheduledJobLockInsert = Insertable<ScheduledJobLockTable>;

interface InMemorySchedulerLockEntry {
  readonly ownerId: string;
  readonly lockedUntil: Date;
}

function normalizeLockTtlMs(ttlMs: number): number {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? Math.max(1, Math.trunc(ttlMs)) : 1;
}

export class NoOpDistributedSchedulerLock implements DistributedSchedulerLock {
  tryAcquire(): boolean {
    return true;
  }

  release(): void {}
}

export class InMemoryDistributedSchedulerLock implements DistributedSchedulerLock {
  private static readonly globalLocks = new Map<string, InMemorySchedulerLockEntry>();

  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly locks = InMemoryDistributedSchedulerLock.globalLocks;

  constructor(options: InMemoryDistributedSchedulerLockOptions = {}) {
    this.ownerId = options.ownerId ?? createRunId("scheduler_owner");
    this.now = options.now ?? (() => new Date());
  }

  tryAcquire(jobId: string, ttlMs: number): boolean {
    const now = this.now();
    const existing = this.locks.get(jobId);

    if (existing && existing.ownerId !== this.ownerId && existing.lockedUntil.getTime() > now.getTime()) {
      return false;
    }

    this.locks.set(jobId, {
      lockedUntil: new Date(now.getTime() + normalizeLockTtlMs(ttlMs)),
      ownerId: this.ownerId
    });
    return true;
  }

  release(jobId: string): void {
    const existing = this.locks.get(jobId);

    if (!existing || existing.ownerId !== this.ownerId) {
      return;
    }

    this.locks.delete(jobId);
  }
}

export class KyselyDistributedSchedulerLock implements DistributedSchedulerLock {
  private readonly ownerId: string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyDistributedSchedulerLockOptions = {}
  ) {
    this.ownerId = options.ownerId ?? createRunId("scheduler_owner");
    this.now = options.now ?? (() => new Date());
  }

  async tryAcquire(jobId: string, ttlMs: number): Promise<boolean> {
    const now = this.now();
    const row = createScheduledJobLockInsert(jobId, this.ownerId, Math.max(1, ttlMs), now);
    const acquired = await this.db
      .insertInto("scheduled_job_locks")
      .values(row)
      .onConflict((oc) =>
        oc.column("job_id").doUpdateSet({
          locked_until: row.locked_until,
          owner_id: row.owner_id,
          updated_at: row.updated_at
        })
          .where((eb) =>
            eb.or([
              eb("scheduled_job_locks.locked_until", "<=", now),
              eb("scheduled_job_locks.owner_id", "=", this.ownerId)
            ])
          )
      )
      .returning(["owner_id"])
      .executeTakeFirst();

    return acquired?.owner_id === this.ownerId;
  }

  async release(jobId: string): Promise<void> {
    await this.db
      .deleteFrom("scheduled_job_locks")
      .where("job_id", "=", jobId)
      .where("owner_id", "=", this.ownerId)
      .execute();
  }
}

export function createScheduledJobLockInsert(
  jobId: string,
  ownerId: string,
  ttlMs: number,
  now: Date
): ScheduledJobLockInsert {
  return {
    created_at: now,
    job_id: jobId,
    locked_until: new Date(now.getTime() + normalizeLockTtlMs(ttlMs)),
    owner_id: ownerId,
    updated_at: now
  };
}
