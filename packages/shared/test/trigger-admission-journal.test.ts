import { describe, expect, it } from "vitest";

import {
  admitTriggerToJournal,
  createTriggerAdmissionJournal,
  createTriggerEnvelope,
  parseTriggerAdmissionJournal,
  serializeTriggerAdmissionJournal,
  settleTriggerAdmission
} from "../src/index.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function envelope(generation: string) {
  return createTriggerEnvelope({
    generation,
    occurredAt: NOW,
    receivedAt: NOW,
    source: "cron",
    sourceId: "daily-brief"
  });
}

describe("trigger admission journal", () => {
  it("preserves exact dedupe across a JSON snapshot restore", () => {
    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 2 }), {
      envelope: envelope("g1"),
      now: NOW
    });
    expect(first).toMatchObject({ decision: { action: "execute" }, recorded: true });

    const restored = parseTriggerAdmissionJournal(
      serializeTriggerAdmissionJournal(first.journal)
    );
    const replay = admitTriggerToJournal(restored, { envelope: envelope("g1"), now: NOW });
    expect(replay).toMatchObject({
      decision: { action: "reject", reasons: ["duplicate"] },
      recorded: false
    });
    expect(replay.journal).toEqual(restored);
  });

  it("derives source cooldown from the restored journal across clock regression", () => {
    const firstAt = new Date("2026-07-30T12:00:01.000Z");
    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 4 }), {
      cooldownMs: 1_000,
      envelope: envelope("g1"),
      now: firstAt
    });
    const restored = parseTriggerAdmissionJournal(
      serializeTriggerAdmissionJournal(first.journal)
    );

    const regressed = admitTriggerToJournal(restored, {
      cooldownMs: 1_000,
      envelope: envelope("g2"),
      now: new Date("2026-07-30T12:00:00.500Z")
    });
    expect(regressed).toMatchObject({
      decision: { action: "reject", reasons: ["cooldown-active"] },
      recorded: true
    });
    expect(regressed.journal.entries.at(-1)).toMatchObject({ state: "rejected" });

    const expired = admitTriggerToJournal(regressed.journal, {
      cooldownMs: 1_000,
      envelope: envelope("g3"),
      now: new Date("2026-07-30T12:00:02.000Z")
    });
    expect(expired).toMatchObject({
      decision: { action: "execute", reasons: [] },
      recorded: true
    });
  });

  it("keeps exact replay dedupe distinct from derived source cooldown", () => {
    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 2 }), {
      cooldownMs: 60_000,
      envelope: envelope("g1"),
      now: NOW
    });
    expect(admitTriggerToJournal(first.journal, {
      cooldownMs: 60_000,
      envelope: envelope("g1"),
      now: NOW
    })).toMatchObject({
      decision: { action: "reject", reasons: ["duplicate"] },
      recorded: false
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "fails closed on invalid cooldown %s even for exact replay",
    (cooldownMs) => {
      const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 2 }), {
        cooldownMs: 1_000,
        envelope: envelope("g1"),
        now: NOW
      });
      expect(() => admitTriggerToJournal(first.journal, {
        cooldownMs,
        envelope: envelope("g1"),
        now: NOW
      })).toThrow(/non-negative safe integer/u);
    }
  );

  it("does not let rejected or shadowed events start or extend cooldown", () => {
    const rejected = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 4 }), {
      cooldownMs: 1_000,
      envelope: envelope("rejected"),
      now: NOW,
      permission: "denied"
    });
    expect(admitTriggerToJournal(rejected.journal, {
      cooldownMs: 1_000,
      envelope: envelope("after-rejected"),
      now: new Date("2026-07-30T12:00:00.250Z")
    }).decision.action).toBe("execute");

    const shadowed = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 4 }), {
      cooldownMs: 1_000,
      envelope: envelope("shadowed"),
      now: NOW,
      quietHoursActive: true
    });
    expect(admitTriggerToJournal(shadowed.journal, {
      cooldownMs: 1_000,
      envelope: envelope("after-shadowed"),
      now: new Date("2026-07-30T12:00:00.250Z")
    }).decision.action).toBe("execute");

    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 4 }), {
      cooldownMs: 1_000,
      envelope: envelope("execute"),
      now: NOW
    });
    const suppressed = admitTriggerToJournal(first.journal, {
      cooldownMs: 1_000,
      envelope: envelope("suppressed"),
      now: new Date("2026-07-30T12:00:00.750Z")
    });
    expect(admitTriggerToJournal(suppressed.journal, {
      cooldownMs: 1_000,
      envelope: envelope("at-original-boundary"),
      now: new Date("2026-07-30T12:00:01.000Z")
    }).decision.action).toBe("execute");
  });

  it("isolates cooldown by source identity and preserves the later caller deadline", () => {
    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 4 }), {
      cooldownMs: 1_000,
      envelope: envelope("g1"),
      now: NOW
    });
    const distinctId = createTriggerEnvelope({
      generation: "g2",
      occurredAt: NOW,
      receivedAt: NOW,
      source: "cron",
      sourceId: "another-job"
    });
    expect(admitTriggerToJournal(first.journal, {
      cooldownMs: 1_000,
      envelope: distinctId,
      now: new Date("2026-07-30T12:00:00.250Z")
    }).decision.action).toBe("execute");

    const distinctSource = createTriggerEnvelope({
      generation: "g3",
      occurredAt: NOW,
      receivedAt: NOW,
      source: "manual",
      sourceId: "daily-brief"
    });
    expect(admitTriggerToJournal(first.journal, {
      cooldownMs: 1_000,
      envelope: distinctSource,
      now: new Date("2026-07-30T12:00:00.250Z")
    }).decision.action).toBe("execute");

    expect(admitTriggerToJournal(first.journal, {
      cooldownMs: 250,
      cooldownUntil: new Date("2026-07-30T12:00:02.000Z"),
      envelope: envelope("g4"),
      now: new Date("2026-07-30T12:00:01.500Z")
    })).toMatchObject({
      decision: { action: "reject", reasons: ["cooldown-active"] }
    });
    expect(admitTriggerToJournal(first.journal, {
      cooldownMs: 2_000,
      cooldownUntil: new Date("2026-07-30T12:00:00.500Z"),
      envelope: envelope("g5"),
      now: new Date("2026-07-30T12:00:01.500Z")
    })).toMatchObject({
      decision: { action: "reject", reasons: ["cooldown-active"] }
    });
  });

  it("turns pending-capacity pressure into a recorded no-effect shadow", () => {
    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: envelope("g1"),
      now: NOW
    });
    const second = admitTriggerToJournal(first.journal, {
      envelope: envelope("g2"),
      now: NOW
    });
    expect(second).toMatchObject({
      decision: { action: "shadow", reasons: ["budget-exhausted"] },
      recorded: true
    });
    expect(second.journal.entries.map((entry) => entry.state)).toEqual(["queued", "shadowed"]);
  });

  it("round-trips exact policy suppression reasons as durable non-effect states", () => {
    const denied = admitTriggerToJournal(
      createTriggerAdmissionJournal({ maxPending: 2 }),
      {
        envelope: envelope("permission-denied"),
        now: NOW,
        permission: "denied"
      }
    );
    const quiet = admitTriggerToJournal(denied.journal, {
      envelope: envelope("quiet-hours"),
      now: NOW,
      quietHoursActive: true,
      relevance: "unknown"
    });
    const restored = parseTriggerAdmissionJournal(
      serializeTriggerAdmissionJournal(quiet.journal)
    );

    expect(restored.entries).toMatchObject([
      {
        decision: { action: "reject", reasons: ["permission-denied"] },
        state: "rejected"
      },
      {
        decision: {
          action: "shadow",
          reasons: ["quiet-hours", "relevance-unknown"]
        },
        state: "shadowed"
      }
    ]);
  });

  it("does not persist invalid or duplicate input", () => {
    const initial = createTriggerAdmissionJournal({ maxPending: 1 });
    const invalid = admitTriggerToJournal(initial, { envelope: {}, now: NOW });
    expect(invalid).toMatchObject({
      decision: { action: "reject", dedupKey: null, reasons: ["invalid"] },
      recorded: false
    });
    expect(invalid.journal).toEqual(initial);
  });

  it("supports monotonic completed and dead-letter terminal settlement", () => {
    const first = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 2 }), {
      envelope: envelope("g1"),
      now: NOW
    });
    const dead = settleTriggerAdmission(first.journal, {
      at: new Date("2026-07-30T12:01:00.000Z"),
      dedupKey: envelope("g1").dedupKey,
      outcome: "dead-lettered",
      reason: "retry-budget-exhausted"
    });
    expect(dead.entries[0]).toMatchObject({
      state: "dead-lettered",
      terminalReason: "retry-budget-exhausted"
    });
    expect(() => settleTriggerAdmission(dead, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "completed"
    })).toThrow(/only queued/u);
  });

  it("requires a reason for dead-letter settlement", () => {
    const queued = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: envelope("g1"),
      now: NOW
    }).journal;
    expect(() => settleTriggerAdmission(queued, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "dead-lettered"
    })).toThrow(/require a reason/u);
  });

  it("persists cancellation as a reason-bound monotonic terminal state", () => {
    const queued = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: envelope("g1"),
      now: NOW
    }).journal;
    expect(() => settleTriggerAdmission(queued, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "cancelled"
    })).toThrow(/require a reason/u);
    const cancelled = settleTriggerAdmission(queued, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "cancelled",
      reason: "owner-stop"
    });
    expect(parseTriggerAdmissionJournal(
      serializeTriggerAdmissionJournal(cancelled)
    ).entries[0]).toMatchObject({
      state: "cancelled",
      terminalReason: "owner-stop"
    });
    expect(() => settleTriggerAdmission(cancelled, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "completed"
    })).toThrow(/only queued/u);
  });

  it("rejects unsafe settlement outcomes and time travel", () => {
    const queued = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: envelope("g1"),
      now: NOW
    }).journal;
    expect(() => settleTriggerAdmission(queued, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "other" as "completed"
    })).toThrow(/invalid.*outcome/u);
    expect(() => settleTriggerAdmission(queued, {
      at: new Date("2026-07-30T11:59:59.000Z"),
      dedupKey: envelope("g1").dedupKey,
      outcome: "completed"
    })).toThrow(/cannot precede/u);
  });

  it("rejects unknown nested envelope fields and normalizes caller snapshots", () => {
    const withUnknownField = {
      ...envelope("g1"),
      provenance: { kind: "local-scheduler" as const, unknown: true }
    };
    expect(admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: withUnknownField,
      now: NOW
    })).toMatchObject({
      decision: { action: "reject", reasons: ["invalid"] },
      recorded: false
    });

    const mutable = JSON.parse(serializeTriggerAdmissionJournal(
      createTriggerAdmissionJournal({ maxPending: 1 })
    ));
    const result = admitTriggerToJournal(mutable, { envelope: {}, now: NOW });
    expect(Object.isFrozen(result.journal)).toBe(true);
    expect(Object.isFrozen(result.journal.entries)).toBe(true);
  });

  it("prunes the oldest terminal record but never a queued record", () => {
    const initial = createTriggerAdmissionJournal({ maxEntries: 2, maxPending: 1 });
    const queued = admitTriggerToJournal(initial, { envelope: envelope("g1"), now: NOW }).journal;
    const done = settleTriggerAdmission(queued, {
      at: NOW,
      dedupKey: envelope("g1").dedupKey,
      outcome: "completed"
    });
    const second = admitTriggerToJournal(done, { envelope: envelope("g2"), now: NOW }).journal;
    const third = admitTriggerToJournal(second, { envelope: envelope("g3"), now: NOW });
    expect(third.recorded).toBe(true);
    expect(third.journal.entries.map((entry) => entry.envelope.generation)).toEqual(["g2", "g3"]);

    const full = createTriggerAdmissionJournal({ maxEntries: 1, maxPending: 1 });
    const pending = admitTriggerToJournal(full, { envelope: envelope("g1"), now: NOW }).journal;
    const overflow = admitTriggerToJournal(pending, { envelope: envelope("g2"), now: NOW });
    expect(overflow).toMatchObject({
      decision: { action: "shadow", reasons: ["budget-exhausted"] },
      journal: { overflowCount: 1 },
      recorded: false
    });
    expect(overflow.journal.entries[0]?.envelope.generation).toBe("g1");
  });

  it("rejects snapshot tampering and non-canonical entry state", () => {
    const journal = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: envelope("g1"),
      now: NOW
    }).journal;
    const tampered = JSON.parse(serializeTriggerAdmissionJournal(journal)) as {
      entries: Array<{ state: string }>;
      snapshotId: string;
    };
    tampered.entries[0]!.state = "completed";
    expect(() => parseTriggerAdmissionJournal(JSON.stringify(tampered))).toThrow();

    const unknownField = JSON.parse(serializeTriggerAdmissionJournal(journal)) as Record<string, unknown>;
    unknownField.extra = true;
    expect(() => parseTriggerAdmissionJournal(JSON.stringify(unknownField))).toThrow();
  });

  it("returns deeply immutable snapshots", () => {
    const result = admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 1 }), {
      envelope: createTriggerEnvelope({
        generation: "g1",
        occurredAt: NOW,
        payload: { nested: ["value"] },
        receivedAt: NOW,
        source: "cron",
        sourceId: "daily-brief"
      }),
      now: NOW
    });
    expect(Object.isFrozen(result.journal)).toBe(true);
    expect(Object.isFrozen(result.journal.entries)).toBe(true);
    expect(Object.isFrozen(result.journal.entries[0]?.envelope.payload)).toBe(true);
  });

  it("does not trust caller-frozen journal lookalikes", () => {
    const journal = createTriggerAdmissionJournal({ maxPending: 1 });
    const forged = Object.freeze({
      ...journal,
      overflowCount: 1
    });
    expect(() => admitTriggerToJournal(forged, {
      envelope: envelope("g1"),
      now: NOW
    })).toThrow(/integrity/u);
  });
});
