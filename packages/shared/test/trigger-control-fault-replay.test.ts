import { describe, expect, it } from "vitest";

import {
  admitTriggerToJournal,
  cancelTriggerWork,
  claimTriggerWork,
  createTriggerAdmissionJournal,
  createTriggerEnvelope,
  parseTriggerAdmissionJournal,
  parseTriggerWorkState,
  resumeTriggerWork,
  serializeTriggerAdmissionJournal,
  serializeTriggerWorkState,
  settleTriggerAdmission,
  settleTriggerWork
} from "../src/index.js";

const T0 = new Date("2026-07-30T12:00:00.000Z");
const T250 = new Date("2026-07-30T12:00:00.250Z");
const T500 = new Date("2026-07-30T12:00:00.500Z");
const T1000 = new Date("2026-07-30T12:00:01.000Z");

function trigger(generation: string) {
  return createTriggerEnvelope({
    generation,
    occurredAt: T0,
    receivedAt: T0,
    source: "webhook",
    sourceId: "mail-arrived"
  });
}

function admit(generation = "g1") {
  return admitTriggerToJournal(createTriggerAdmissionJournal({
    maxEntries: 8,
    maxPending: 2
  }), {
    envelope: trigger(generation),
    now: T0
  }).journal;
}

function claim(journal = admit()) {
  return claimTriggerWork(journal, {
    at: T0,
    dedupKey: journal.entries[0]!.envelope.dedupKey,
    leaseDurationMs: 1_000,
    leaseToken: "worker-a:1",
    maxAttempts: 2
  });
}

describe("trigger control crash and replay", () => {
  it("restores admission before claim without losing exact dedupe", () => {
    const crashed = parseTriggerAdmissionJournal(
      serializeTriggerAdmissionJournal(admit())
    );
    const replay = admitTriggerToJournal(crashed, {
      envelope: trigger("g1"),
      now: T250
    });
    expect(replay).toMatchObject({
      decision: { action: "reject", reasons: ["duplicate"] },
      recorded: false
    });
    expect(claimTriggerWork(crashed, {
      at: T250,
      dedupKey: trigger("g1").dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1",
      maxAttempts: 2
    }).status).toBe("leased");
  });

  it("reclaims an expired lease and rejects the old worker token", () => {
    const beforeCrash = parseTriggerWorkState(serializeTriggerWorkState(claim()));
    const reclaimed = resumeTriggerWork(beforeCrash, {
      at: T1000,
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    });
    expect(reclaimed).toMatchObject({
      attempt: 2,
      leaseToken: "worker-b:2",
      status: "leased"
    });
    expect(() => settleTriggerWork(reclaimed, {
      at: new Date("2026-07-30T12:00:01.250Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    })).toThrow(/stale/u);
  });

  it("never executes a duplicate event while its first occurrence is active", () => {
    const journal = admit();
    const active = claim(journal);
    const duplicate = admitTriggerToJournal(journal, {
      envelope: trigger("g1"),
      now: T500
    });
    expect(active.status).toBe("leased");
    expect(duplicate).toMatchObject({
      decision: { action: "reject", reasons: ["duplicate"] },
      recorded: false
    });
    expect(duplicate.journal.entries).toHaveLength(1);
  });

  it("fences late success after owner cancellation", () => {
    const admitted = admit();
    const cancelled = cancelTriggerWork(claim(), {
      at: T250,
      leaseToken: "worker-a:1",
      reason: "owner-stop"
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminalReason: "owner-stop"
    });
    expect(() => settleTriggerWork(cancelled, {
      at: T500,
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    })).toThrow(/only leased/u);
    const settledJournal = settleTriggerAdmission(admitted, {
      at: T250,
      dedupKey: cancelled.dedupKey,
      outcome: "cancelled",
      reason: cancelled.terminalReason
    });
    expect(settledJournal.entries[0]).toMatchObject({
      state: "cancelled",
      terminalReason: "owner-stop"
    });
  });

  it("keeps capacity-shadowed work outside the claimable queue", () => {
    const initial = createTriggerAdmissionJournal({ maxEntries: 2, maxPending: 1 });
    const first = admitTriggerToJournal(initial, {
      envelope: trigger("g1"),
      now: T0
    }).journal;
    const pressured = admitTriggerToJournal(first, {
      envelope: trigger("g2"),
      now: T0
    }).journal;
    const shadowed = pressured.entries.find((entry) => entry.envelope.generation === "g2")!;
    expect(shadowed.state).toBe("shadowed");
    expect(() => claimTriggerWork(pressured, {
      at: T0,
      dedupKey: shadowed.envelope.dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:1",
      maxAttempts: 1
    })).toThrow(/only queued/u);
  });

  it("settles successful and permanent-failure paths monotonically", () => {
    const successJournal = admit("success");
    const completedWork = settleTriggerWork(claim(successJournal), {
      at: T500,
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    });
    const completedJournal = settleTriggerAdmission(successJournal, {
      at: T500,
      dedupKey: completedWork.dedupKey,
      outcome: "completed"
    });
    expect(completedJournal.entries[0]?.state).toBe("completed");
    expect(() => settleTriggerAdmission(completedJournal, {
      at: T1000,
      dedupKey: completedWork.dedupKey,
      outcome: "dead-lettered",
      reason: "late-failure"
    })).toThrow(/only queued/u);

    const failedJournal = admit("failure");
    const deadWork = settleTriggerWork(claim(failedJournal), {
      at: T500,
      leaseToken: "worker-a:1",
      outcome: "failed",
      reason: "invalid-payload",
      retryable: false
    });
    const deadJournal = settleTriggerAdmission(failedJournal, {
      at: T500,
      dedupKey: deadWork.dedupKey,
      outcome: "dead-lettered",
      reason: deadWork.terminalReason
    });
    expect(deadJournal.entries[0]).toMatchObject({
      state: "dead-lettered",
      terminalReason: "invalid-payload"
    });
    expect(() => settleTriggerAdmission(deadJournal, {
      at: T1000,
      dedupKey: deadWork.dedupKey,
      outcome: "completed"
    })).toThrow(/only queued/u);
  });

  it("replays identical commands to identical content-bound state IDs", () => {
    const replay = (nextLeaseToken = "worker-b:2") => {
      const waiting = settleTriggerWork(claim(), {
        at: T250,
        leaseToken: "worker-a:1",
        outcome: "failed",
        reason: "temporary",
        retryable: true,
        retryDelayMs: 250
      });
      return resumeTriggerWork(waiting, {
        at: T500,
        leaseDurationMs: 1_000,
        leaseToken: nextLeaseToken
      });
    };
    const first = replay();
    const second = replay();
    expect(first).toEqual(second);
    expect(first.stateId).toMatch(/^trigger-work:[a-f0-9]{64}$/u);
    expect(first.stateId).toBe(second.stateId);
    expect(replay("worker-c:2").stateId).not.toBe(first.stateId);
  });
});
