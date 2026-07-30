import { describe, expect, it } from "vitest";

import {
  admitTriggerToJournal,
  cancelTriggerWork,
  claimTriggerWork,
  createTriggerAdmissionJournal,
  createTriggerEnvelope,
  parseTriggerWorkState,
  resumeTriggerWork,
  serializeTriggerWorkState,
  settleTriggerWork
} from "../src/index.js";

const START = new Date("2026-07-30T12:00:00.000Z");

function queuedJournal() {
  const envelope = createTriggerEnvelope({
    generation: "g1",
    occurredAt: START,
    receivedAt: START,
    source: "cron",
    sourceId: "daily-brief"
  });
  return admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
    envelope,
    now: START
  }).journal;
}

function lease(maxAttempts = 3) {
  const journal = queuedJournal();
  return claimTriggerWork(journal, {
    at: START,
    dedupKey: journal.entries[0]!.envelope.dedupKey,
    leaseDurationMs: 1_000,
    leaseToken: "worker-a:1",
    maxAttempts
  });
}

describe("trigger work state", () => {
  it("claims only queued admission entries with a bounded lease", () => {
    expect(lease()).toMatchObject({
      attempt: 1,
      leaseExpiresAt: "2026-07-30T12:00:01.000Z",
      leaseToken: "worker-a:1",
      maxAttempts: 3,
      status: "leased"
    });
    const shadowed = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      budgetAvailable: false,
      envelope: createTriggerEnvelope({
        generation: "g1",
        occurredAt: START,
        receivedAt: START,
        source: "cron",
        sourceId: "daily-brief"
      }),
      now: START
    }).journal;
    expect(() => claimTriggerWork(shadowed, {
      at: START,
      dedupKey: shadowed.entries[0]!.envelope.dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1",
      maxAttempts: 3
    })).toThrow(/only queued/u);
  });

  it("rejects stale tokens, settlement after expiry, and unsafe outcomes", () => {
    expect(() => settleTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-b:1",
      outcome: "succeeded"
    })).toThrow(/stale/u);
    expect(() => settleTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:01.000Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    })).toThrow(/expired/u);
    expect(() => settleTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "other" as "succeeded"
    })).toThrow(/invalid.*outcome/u);
  });

  it("settles success exactly once", () => {
    const completed = settleTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    });
    expect(completed.status).toBe("completed");
    expect(() => settleTriggerWork(completed, {
      at: new Date("2026-07-30T12:00:00.600Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    })).toThrow(/only leased/u);
  });

  it("waits before retry and issues a new fenced lease when due", () => {
    const waiting = settleTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "failed",
      reason: "temporary",
      retryable: true,
      retryDelayMs: 500
    });
    expect(waiting).toMatchObject({
      attempt: 1,
      nextAttemptAt: "2026-07-30T12:00:01.000Z",
      status: "retry-wait"
    });
    expect(() => resumeTriggerWork(waiting, {
      at: new Date("2026-07-30T12:00:00.999Z"),
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    })).toThrow(/not due/u);
    expect(() => resumeTriggerWork(waiting, {
      at: new Date("2026-07-30T12:00:01.000Z"),
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1"
    })).toThrow(/must be unique/u);
    expect(resumeTriggerWork(waiting, {
      at: new Date("2026-07-30T12:00:01.000Z"),
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    })).toMatchObject({ attempt: 2, leaseToken: "worker-b:2", status: "leased" });
  });

  it("dead-letters permanent failures and exhausted retries", () => {
    expect(settleTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "failed",
      reason: "invalid payload",
      retryable: false
    })).toMatchObject({ status: "dead-lettered", terminalReason: "invalid payload" });

    expect(resumeTriggerWork(lease(1), {
      at: new Date("2026-07-30T12:00:01.000Z"),
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    })).toMatchObject({ status: "dead-lettered", terminalReason: "lease-expired" });
  });

  it("requires a new fencing token when reclaiming an expired lease", () => {
    expect(() => resumeTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:01.000Z"),
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1"
    })).toThrow(/must be unique/u);
    expect(resumeTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:01.000Z"),
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    })).toMatchObject({ attempt: 2, leaseToken: "worker-b:2", status: "leased" });
  });

  it("cancels active work and fences a late completion", () => {
    const cancelled = cancelTriggerWork(lease(), {
      at: new Date("2026-07-30T12:00:00.250Z"),
      reason: "owner-stop"
    });
    expect(cancelled).toMatchObject({ status: "cancelled", terminalReason: "owner-stop" });
    expect(() => settleTriggerWork(cancelled, {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    })).toThrow(/only leased/u);
  });

  it("preserves fencing state across strict JSON restore", () => {
    const restored = parseTriggerWorkState(serializeTriggerWorkState(lease()));
    expect(restored).toEqual(lease());
    expect(Object.isFrozen(restored)).toBe(true);

    const tampered = JSON.parse(serializeTriggerWorkState(lease())) as {
      leaseToken: string;
    };
    tampered.leaseToken = "attacker";
    expect(() => parseTriggerWorkState(JSON.stringify(tampered))).toThrow(/integrity/u);
  });

  it("normalizes mutable caller state before transitions", () => {
    const mutable = JSON.parse(serializeTriggerWorkState(lease()));
    const completed = settleTriggerWork(mutable, {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    });
    expect(Object.isFrozen(completed)).toBe(true);
  });

  it("does not trust caller-frozen work-state lookalikes", () => {
    const forged = Object.freeze({
      ...lease(),
      leaseToken: "attacker"
    });
    expect(() => settleTriggerWork(forged, {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "attacker",
      outcome: "succeeded"
    })).toThrow(/integrity/u);
  });
});
