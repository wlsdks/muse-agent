import { describe, expect, it } from "vitest";

import {
  admitTriggerToJournal,
  admitTriggerControl,
  cancelTriggerControlWork,
  claimTriggerControlWork,
  createTriggerAdmissionJournal,
  createTriggerControlState,
  createTriggerControlStateFromJournal,
  createTriggerEnvelope,
  parseTriggerControlState,
  resumeTriggerControlWork,
  serializeTriggerControlState,
  settleTriggerAdmission,
  settleTriggerControlWork
} from "../src/index.js";

const T0 = new Date("2026-07-30T12:00:00.000Z");
const T250 = new Date("2026-07-30T12:00:00.250Z");
const T500 = new Date("2026-07-30T12:00:00.500Z");
const T1000 = new Date("2026-07-30T12:00:01.000Z");

function envelope(generation = "g1") {
  return createTriggerEnvelope({
    generation,
    occurredAt: T0,
    receivedAt: T0,
    source: "cron",
    sourceId: "daily-brief"
  });
}

function admitted(generation = "g1") {
  return admitTriggerControl(createTriggerControlState({ maxEntries: 4, maxPending: 2 }), {
    envelope: envelope(generation),
    now: T0
  }).state;
}

function claimed(generation = "g1", maxAttempts = 2) {
  const state = admitted(generation);
  return claimTriggerControlWork(state, {
    at: T0,
    dedupKey: envelope(generation).dedupKey,
    leaseDurationMs: 1_000,
    leaseToken: "worker-a:1",
    maxAttempts
  });
}

describe("trigger control state", () => {
  it("imports legacy journal history without inventing active work", () => {
    const queuedEnvelope = envelope("legacy-queued");
    const completedEnvelope = envelope("legacy-completed");
    const cancelledEnvelope = envelope("legacy-cancelled");
    const deadLetteredEnvelope = envelope("legacy-dead-lettered");
    const rejectedEnvelope = envelope("legacy-rejected");
    let journal = createTriggerAdmissionJournal({ maxEntries: 8, maxPending: 4 });
    for (const occurrence of [
      queuedEnvelope,
      completedEnvelope,
      cancelledEnvelope,
      deadLetteredEnvelope
    ]) {
      journal = admitTriggerToJournal(journal, {
        envelope: occurrence,
        now: T0
      }).journal;
    }
    journal = settleTriggerAdmission(journal, {
      at: T500,
      dedupKey: completedEnvelope.dedupKey,
      outcome: "completed"
    });
    journal = settleTriggerAdmission(journal, {
      at: T500,
      dedupKey: cancelledEnvelope.dedupKey,
      outcome: "cancelled",
      reason: "owner-stop"
    });
    journal = settleTriggerAdmission(journal, {
      at: T500,
      dedupKey: deadLetteredEnvelope.dedupKey,
      outcome: "dead-lettered",
      reason: "retry-budget-exhausted"
    });
    journal = admitTriggerToJournal(journal, {
      envelope: rejectedEnvelope,
      now: T1000,
      permission: "denied"
    }).journal;

    const imported = createTriggerControlStateFromJournal(journal);
    expect(imported.journal).toBe(journal);
    expect(imported.revision).toBe(0);
    expect(imported.workStates).toHaveLength(3);
    expect(imported.workStates.find((work) =>
      work.dedupKey === completedEnvelope.dedupKey)).toMatchObject({
      attempt: 1,
      maxAttempts: 1,
      status: "completed",
      updatedAt: T500.toISOString()
    });
    expect(imported.workStates.find((work) =>
      work.dedupKey === cancelledEnvelope.dedupKey)).toMatchObject({
      status: "cancelled",
      terminalReason: "owner-stop"
    });
    expect(imported.workStates.find((work) =>
      work.dedupKey === deadLetteredEnvelope.dedupKey)).toMatchObject({
      status: "dead-lettered",
      terminalReason: "retry-budget-exhausted"
    });
    expect(imported.workStates.some((work) =>
      work.dedupKey === queuedEnvelope.dedupKey)).toBe(false);
    expect(imported.workStates.some((work) =>
      work.dedupKey === rejectedEnvelope.dedupKey)).toBe(false);
    expect(parseTriggerControlState(serializeTriggerControlState(imported))).toEqual(imported);
  });

  it("advances one revision across admit and claim", () => {
    const initial = createTriggerControlState({ maxPending: 1 });
    const afterAdmission = admitTriggerControl(initial, {
      envelope: envelope(),
      now: T0
    });
    const afterClaim = claimTriggerControlWork(afterAdmission.state, {
      at: T0,
      dedupKey: envelope().dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1",
      maxAttempts: 2
    });
    expect(initial.revision).toBe(0);
    expect(afterAdmission.state.revision).toBe(1);
    expect(afterClaim).toMatchObject({
      journal: { entries: [{ state: "queued" }] },
      revision: 2,
      workStates: [{ status: "leased" }]
    });
  });

  it("keeps duplicate admission state-stable and rejects duplicate work claim", () => {
    const state = admitted();
    const replay = admitTriggerControl(state, { envelope: envelope(), now: T250 });
    expect(replay).toMatchObject({
      decision: { action: "reject", reasons: ["duplicate"] },
      recorded: false
    });
    expect(replay.state).toBe(state);

    const active = claimed();
    expect(() => claimTriggerControlWork(active, {
      at: T250,
      dedupKey: envelope().dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2",
      maxAttempts: 2
    })).toThrow(/already exists/u);
  });

  it.each([
    ["permission-denied", { permission: "denied" as const }],
    ["permission-unknown", { permission: "unknown" as const }],
    ["quiet-hours", { quietHoursActive: true }],
    ["irrelevant", { relevance: "irrelevant" as const }],
    ["relevance-unknown", { relevance: "unknown" as const }]
  ])("records %s suppression and refuses a work claim", (reason, policy) => {
    const admission = admitTriggerControl(
      createTriggerControlState({ maxEntries: 4, maxPending: 2 }),
      {
        envelope: envelope(reason),
        now: T0,
        ...policy
      }
    );
    expect(admission).toMatchObject({
      decision: { reasons: [reason] },
      recorded: true
    });
    expect(admission.state.journal.entries[0]?.state).not.toBe("queued");
    expect(() => claimTriggerControlWork(admission.state, {
      at: T0,
      dedupKey: envelope(reason).dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1",
      maxAttempts: 2
    })).toThrow(/only queued/u);
  });

  it("refuses burst claims after restart and clock regression until cooldown expires", () => {
    const first = admitTriggerControl(
      createTriggerControlState({ maxEntries: 4, maxPending: 2 }),
      {
        cooldownMs: 1_000,
        envelope: envelope("g1"),
        now: T1000
      }
    );
    let state = parseTriggerControlState(serializeTriggerControlState(first.state));
    let rejected = 0;
    for (const [generation, at] of [
      ["g2", T500],
      ["g3", new Date("2026-07-30T12:00:01.250Z")],
      ["g4", new Date("2026-07-30T12:00:01.750Z")]
    ] as const) {
      const suppressed = admitTriggerControl(state, {
        cooldownMs: 1_000,
        envelope: envelope(generation),
        now: at
      });
      expect(suppressed).toMatchObject({
        decision: { action: "reject", reasons: ["cooldown-active"] },
        recorded: true
      });
      expect(() => claimTriggerControlWork(suppressed.state, {
        at,
        dedupKey: envelope(generation).dedupKey,
        leaseDurationMs: 1_000,
        leaseToken: `worker-a:${generation}`,
        maxAttempts: 2
      })).toThrow(/only queued/u);
      rejected += 1;
      state = suppressed.state;
    }
    expect(rejected).toBe(3);
    expect(admitTriggerControl(state, {
      cooldownMs: 1_000,
      envelope: envelope("g5"),
      now: new Date("2026-07-30T12:00:02.000Z")
    }).decision.action).toBe("execute");
  });

  it("atomically settles success in work and journal", () => {
    const completed = settleTriggerControlWork(claimed(), {
      at: T500,
      dedupKey: envelope().dedupKey,
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    });
    expect(completed).toMatchObject({
      journal: { entries: [{ state: "completed" }] },
      workStates: [{ status: "completed" }]
    });
  });

  it("keeps retry wait queued and atomically resumes with a fresh fence", () => {
    const waiting = settleTriggerControlWork(claimed(), {
      at: T250,
      dedupKey: envelope().dedupKey,
      leaseToken: "worker-a:1",
      outcome: "failed",
      reason: "temporary",
      retryable: true,
      retryDelayMs: 250
    });
    expect(waiting).toMatchObject({
      journal: { entries: [{ state: "queued" }] },
      workStates: [{ status: "retry-wait" }]
    });
    const resumed = resumeTriggerControlWork(waiting, {
      at: T500,
      dedupKey: envelope().dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    });
    expect(resumed.workStates[0]).toMatchObject({
      attempt: 2,
      leaseToken: "worker-b:2",
      status: "leased"
    });
  });

  it("atomically dead-letters an expired final lease", () => {
    const dead = resumeTriggerControlWork(claimed("g1", 1), {
      at: T1000,
      dedupKey: envelope().dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-b:2"
    });
    expect(dead).toMatchObject({
      journal: {
        entries: [{ state: "dead-lettered", terminalReason: "lease-expired" }]
      },
      workStates: [{ status: "dead-lettered", terminalReason: "lease-expired" }]
    });
  });

  it("atomically cancels and fences terminal replay", () => {
    const cancelled = cancelTriggerControlWork(claimed(), {
      at: T250,
      dedupKey: envelope().dedupKey,
      reason: "owner-stop"
    });
    expect(cancelled).toMatchObject({
      journal: { entries: [{ state: "cancelled", terminalReason: "owner-stop" }] },
      workStates: [{ status: "cancelled", terminalReason: "owner-stop" }]
    });
    expect(() => settleTriggerControlWork(cancelled, {
      at: T500,
      dedupKey: envelope().dedupKey,
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    })).toThrow(/only leased/u);
  });

  it("restores one content-bound snapshot and rejects split-brain tampering", () => {
    const state = settleTriggerControlWork(claimed(), {
      at: T500,
      dedupKey: envelope().dedupKey,
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    });
    const restored = parseTriggerControlState(serializeTriggerControlState(state));
    expect(restored).toEqual(state);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.workStates)).toBe(true);

    const split = JSON.parse(serializeTriggerControlState(state)) as {
      journal: { entries: Array<{ state: string }> };
      stateId: string;
    };
    split.journal.entries[0]!.state = "queued";
    expect(() => parseTriggerControlState(JSON.stringify(split))).toThrow();
  });

  it("rejects accessors and toJSON without executing caller code", () => {
    const plain = JSON.parse(serializeTriggerControlState(claimed())) as Record<string, unknown>;
    let calls = 0;
    Object.defineProperty(plain, "toJSON", {
      value: () => {
        calls += 1;
        return {};
      }
    });
    expect(() => serializeTriggerControlState(plain as never)).toThrow(/data property/u);
    expect(calls).toBe(0);

    const nested = JSON.parse(serializeTriggerControlState(claimed())) as {
      journal: Record<string, unknown>;
    };
    const snapshotId = nested.journal.snapshotId;
    Object.defineProperty(nested.journal, "snapshotId", {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1;
        return snapshotId;
      }
    });
    expect(() => serializeTriggerControlState(nested as never)).toThrow(/data property/u);
    expect(calls).toBe(0);
  });
});
