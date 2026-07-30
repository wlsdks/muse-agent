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
});
