import { describe, expect, it } from "vitest";

import {
  InMemoryDistributedSchedulerLock,
  NoOpDistributedSchedulerLock,
  createScheduledJobLockInsert
} from "../src/scheduler-locks.js";

// Direct coverage for the distributed scheduler lock primitives (untested
// module). These guard the single-flight invariant: across many pods only ONE
// may run a scheduled job per TTL window. A broken lock = the same job firing
// twice (a double email / double charge), so the contention state machine —
// mutual exclusion, owner-scoped release, TTL-bounded steal — is load-bearing.
//
// `InMemoryDistributedSchedulerLock` keeps its map in a process-global static,
// so two instances with DIFFERENT owners model two pods contending on the SAME
// job in-process. Each test therefore uses a UNIQUE jobId to stay isolated from
// the shared global map.
//
// The PostgreSQL `KyselyDistributedSchedulerLock` is intentionally NOT faked
// here: its correctness lives entirely in the `ON CONFLICT … WHERE locked_until
// <= now OR owner_id = self` SQL semantics, which only a real Postgres
// (testcontainers, backlog P4) exercises faithfully — a hand fake would assert
// the mock, not the lock. The row it builds IS covered via
// createScheduledJobLockInsert below.

let counter = 0;
const uniqueJob = (): string => `job-${(counter++).toString()}-${process.pid.toString()}`;
const clock = (ref: { t: number }) => () => new Date(ref.t);

describe("NoOpDistributedSchedulerLock", () => {
  it("always acquires and release is a no-op (single-instance dev fallback)", () => {
    const lock = new NoOpDistributedSchedulerLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.release()).toBeUndefined();
  });
});

describe("InMemoryDistributedSchedulerLock", () => {
  it("grants the lock to the first owner and BLOCKS a second owner while the TTL is valid (mutual exclusion)", () => {
    const ref = { t: 0 };
    const job = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    const b = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-b" });
    expect(a.tryAcquire(job, 1000)).toBe(true);
    expect(b.tryAcquire(job, 1000)).toBe(false);
  });

  it("lets the SAME owner re-acquire (refresh) its own live lock", () => {
    const ref = { t: 0 };
    const job = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    expect(a.tryAcquire(job, 1000)).toBe(true);
    ref.t = 500;
    expect(a.tryAcquire(job, 1000)).toBe(true); // still mid-TTL, owner refreshes
  });

  it("only the OWNER can release — a foreign release does NOT free the lock", () => {
    const ref = { t: 0 };
    const job = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    const b = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-b" });
    expect(a.tryAcquire(job, 1000)).toBe(true);
    b.release(job); // b does not own it
    expect(b.tryAcquire(job, 1000)).toBe(false); // a's lock survived the foreign release
    a.release(job); // owner releases
    expect(b.tryAcquire(job, 1000)).toBe(true); // now free
  });

  it("lets another owner STEAL the lock once the prior owner's TTL has expired", () => {
    const ref = { t: 0 };
    const job = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    const b = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-b" });
    expect(a.tryAcquire(job, 1000)).toBe(true); // lockedUntil = 1000
    ref.t = 999;
    expect(b.tryAcquire(job, 1000)).toBe(false); // still inside the window
    ref.t = 1000;
    expect(b.tryAcquire(job, 1000)).toBe(true); // at exactly lockedUntil the lock is stealable (strict >)
    ref.t = 1000;
    expect(a.tryAcquire(job, 1000)).toBe(false); // b now holds it
  });

  it("keeps locks on DIFFERENT jobs independent (a held job does not block another)", () => {
    const ref = { t: 0 };
    const j1 = uniqueJob();
    const j2 = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    const b = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-b" });
    expect(a.tryAcquire(j1, 1000)).toBe(true);
    expect(b.tryAcquire(j2, 1000)).toBe(true); // different job — not contended
  });

  it("floors a non-positive TTL to 1ms so the lock still holds for a tick", () => {
    const ref = { t: 0 };
    const job = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    const b = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-b" });
    expect(a.tryAcquire(job, 0)).toBe(true); // lockedUntil = 0 + max(1,0) = 1
    expect(b.tryAcquire(job, 1000)).toBe(false); // now=0 < 1, still held
    ref.t = 1;
    expect(b.tryAcquire(job, 1000)).toBe(true); // expired at the floored tick
  });

  it("fails safe to a 1ms TTL for a non-finite value instead of creating an immediately-expired invalid date", () => {
    const ref = { t: 0 };
    const job = uniqueJob();
    const a = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-a" });
    const b = new InMemoryDistributedSchedulerLock({ now: clock(ref), ownerId: "pod-b" });
    expect(a.tryAcquire(job, Number.NaN)).toBe(true);
    expect(b.tryAcquire(job, 1000)).toBe(false);
    ref.t = 1;
    expect(b.tryAcquire(job, 1000)).toBe(true);
  });
});

describe("createScheduledJobLockInsert", () => {
  it("builds the row with locked_until = now + ttl and now-stamped created/updated", () => {
    const row = createScheduledJobLockInsert("jobX", "owner-1", 5000, new Date(1000));
    expect(row.job_id).toBe("jobX");
    expect(row.owner_id).toBe("owner-1");
    expect((row.created_at as Date).getTime()).toBe(1000);
    expect((row.updated_at as Date).getTime()).toBe(1000);
    expect((row.locked_until as Date).getTime()).toBe(6000);
  });

  it("floors a non-positive TTL to 1ms in the persisted locked_until", () => {
    const row = createScheduledJobLockInsert("jobY", "owner-1", 0, new Date(1000));
    expect((row.locked_until as Date).getTime()).toBe(1001);
    const neg = createScheduledJobLockInsert("jobZ", "owner-1", -50, new Date(1000));
    expect((neg.locked_until as Date).getTime()).toBe(1001);
  });

  it("uses a valid minimum TTL for a non-finite persisted value", () => {
    const row = createScheduledJobLockInsert("job-nan", "owner-1", Number.NaN, new Date(1000));
    expect((row.locked_until as Date).getTime()).toBe(1001);
  });
});
