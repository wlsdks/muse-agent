import type { BeliefProvenance } from "@muse/memory";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_JOURNEY_LIMIT,
  factRecordsFromProvenance,
  mergeJourneyEvents,
  resolveJourneyForgetTarget,
  type JourneyEvent,
  type JourneyFactRecord,
  type JourneySkillRecord,
  type JourneyStrategyRecord
} from "../src/journey-timeline.js";

const fact: JourneyFactRecord = {
  key: "home_city",
  steps: [
    { value: "Busan", at: "2026-01-01T00:00:00.000Z" },
    { value: "Seoul", at: "2026-03-01T00:00:00.000Z" }
  ]
};

const skill: JourneySkillRecord = {
  name: "vpn-fix",
  description: "Reconnect the office VPN",
  authoredAt: "2026-02-01T00:00:00.000Z",
  lastUsedAt: "2026-02-15T00:00:00.000Z"
};

const strategy: JourneyStrategyRecord = {
  id: "pb_abc123",
  text: "keep work emails under 4 sentences",
  createdAt: "2026-01-15T00:00:00.000Z",
  lastReinforcedAt: "2026-02-20T00:00:00.000Z"
};

describe("mergeJourneyEvents", () => {
  it("merges events across stores newest-first", () => {
    const events = mergeJourneyEvents({ facts: [fact], skills: [skill], strategies: [strategy] });
    const dates = events.map((e) => e.at);
    const sorted = [...dates].sort((a, b) => Date.parse(b) - Date.parse(a));
    expect(dates).toEqual(sorted);
    // newest event overall is the fact's supersession (2026-03-01)
    expect(events[0]?.at).toBe("2026-03-01T00:00:00.000Z");
    expect(events[0]?.storeKind).toBe("fact");
  });

  it("renders a superseded chain as separate learned + superseded events", () => {
    const events = mergeJourneyEvents({ facts: [fact] });
    expect(events).toHaveLength(2);
    const learned = events.find((e) => e.eventKind === "learned");
    const superseded = events.find((e) => e.eventKind === "superseded");
    expect(learned).toMatchObject({ at: "2026-01-01T00:00:00.000Z", ref: "home_city", storeKind: "fact" });
    expect(learned?.content).toContain("Busan");
    expect(superseded).toMatchObject({ at: "2026-03-01T00:00:00.000Z", ref: "home_city", storeKind: "fact" });
    expect(superseded?.content).toContain("Busan");
    expect(superseded?.content).toContain("Seoul");
  });

  it("emits a forgotten event at the retraction timestamp", () => {
    const forgotten: JourneyFactRecord = { key: "old_pet", steps: [{ value: "cat", at: "2026-01-01T00:00:00.000Z" }], forgottenAt: "2026-04-01T00:00:00.000Z" };
    const events = mergeJourneyEvents({ facts: [forgotten] });
    expect(events[0]).toMatchObject({ at: "2026-04-01T00:00:00.000Z", eventKind: "forgotten", ref: "old_pet" });
  });

  it("a skill contributes a 'skill' event at authoredAt and an 'updated' event at lastUsedAt", () => {
    const events = mergeJourneyEvents({ skills: [skill] });
    expect(events).toHaveLength(2);
    const created = events.find((e) => e.eventKind === "skill");
    const used = events.find((e) => e.eventKind === "updated");
    expect(created).toMatchObject({ at: "2026-02-01T00:00:00.000Z", ref: "vpn-fix", storeKind: "skill" });
    expect(used).toMatchObject({ at: "2026-02-15T00:00:00.000Z", ref: "vpn-fix", storeKind: "skill" });
  });

  it("a never-used skill contributes only the 'skill' created event", () => {
    const unused: JourneySkillRecord = { name: "idle-skill", authoredAt: "2026-02-01T00:00:00.000Z" };
    const events = mergeJourneyEvents({ skills: [unused] });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("skill");
  });

  it("a strategy contributes a 'strategy' event at createdAt and an 'updated' event at lastReinforcedAt", () => {
    const events = mergeJourneyEvents({ strategies: [strategy] });
    expect(events).toHaveLength(2);
    const created = events.find((e) => e.eventKind === "strategy");
    const reinforced = events.find((e) => e.eventKind === "updated");
    expect(created).toMatchObject({ at: "2026-01-15T00:00:00.000Z", ref: "pb_abc123", storeKind: "strategy" });
    expect(reinforced).toMatchObject({ at: "2026-02-20T00:00:00.000Z", ref: "pb_abc123", storeKind: "strategy" });
  });

  it("filters by storeKind via `kind`", () => {
    const events = mergeJourneyEvents({ facts: [fact], skills: [skill], strategies: [strategy], kind: "strategy" });
    expect(events.every((e) => e.storeKind === "strategy")).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it("filters by `since` (inclusive lower bound)", () => {
    const events = mergeJourneyEvents({ facts: [fact], since: "2026-02-01T00:00:00.000Z" });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("superseded");
  });

  it("applies `limit`, defaulting to DEFAULT_JOURNEY_LIMIT", () => {
    const manyFacts: JourneyFactRecord[] = Array.from({ length: 60 }, (_, i) => ({
      key: `k${i.toString()}`,
      steps: [{ value: "v", at: new Date(2026, 0, i + 1).toISOString() }]
    }));
    const events = mergeJourneyEvents({ facts: manyFacts });
    expect(events).toHaveLength(DEFAULT_JOURNEY_LIMIT);
    const limited = mergeJourneyEvents({ facts: manyFacts, limit: 5 });
    expect(limited).toHaveLength(5);
  });

  it("ties break deterministically (same timestamp, different storeKind/ref)", () => {
    const a: JourneyFactRecord = { key: "a_key", steps: [{ value: "1", at: "2026-01-01T00:00:00.000Z" }] };
    const b: JourneyFactRecord = { key: "b_key", steps: [{ value: "2", at: "2026-01-01T00:00:00.000Z" }] };
    const first = mergeJourneyEvents({ facts: [a, b] });
    const second = mergeJourneyEvents({ facts: [b, a] });
    expect(first).toEqual(second);
  });

  it("empty stores produce an empty timeline", () => {
    expect(mergeJourneyEvents({})).toEqual([]);
    expect(mergeJourneyEvents({ facts: [], skills: [], strategies: [] })).toEqual([]);
  });

  it("a fact record with no history and no forget produces no event (never invents a timestamp)", () => {
    const noHistory: JourneyFactRecord = { key: "stable_key", steps: [] };
    expect(mergeJourneyEvents({ facts: [noHistory] })).toEqual([]);
  });
});

describe("resolveJourneyForgetTarget", () => {
  const events: readonly JourneyEvent[] = [
    { at: "2026-01-01T00:00:00.000Z", storeKind: "fact", eventKind: "learned", content: "home_city: Busan", ref: "home_city" },
    { at: "2026-01-15T00:00:00.000Z", storeKind: "strategy", eventKind: "strategy", content: "learned strategy", ref: "pb_abc123def456" },
    { at: "2026-02-01T00:00:00.000Z", storeKind: "skill", eventKind: "skill", content: "authored skill", ref: "vpn-fix" }
  ];

  it("resolves an exact ref match", () => {
    expect(resolveJourneyForgetTarget(events, "home_city")).toEqual({ storeKind: "fact", ref: "home_city" });
  });

  it("resolves a prefix match for a longer ref (e.g. a playbook id)", () => {
    expect(resolveJourneyForgetTarget(events, "pb_abc123")).toEqual({ storeKind: "strategy", ref: "pb_abc123def456" });
  });

  it("returns undefined when no event matches", () => {
    expect(resolveJourneyForgetTarget(events, "nope")).toBeUndefined();
  });

  it("resolves a skill by exact name", () => {
    expect(resolveJourneyForgetTarget(events, "vpn-fix")).toEqual({ storeKind: "skill", ref: "vpn-fix" });
  });
});

describe("factRecordsFromProvenance", () => {
  const base = (overrides: Partial<BeliefProvenance>): BeliefProvenance => ({
    key: "home_city",
    kind: "fact",
    learnedAt: "2026-01-01T00:00:00.000Z",
    userId: "u1",
    value: "Busan",
    ...overrides
  });

  it("groups entries by key into value-change steps, oldest first", () => {
    const entries = [
      base({ learnedAt: "2026-01-01T00:00:00.000Z", value: "Busan" }),
      base({ learnedAt: "2026-03-01T00:00:00.000Z", value: "Seoul" })
    ];
    const [record] = factRecordsFromProvenance(entries);
    expect(record?.key).toBe("home_city");
    expect(record?.steps).toEqual([
      { at: "2026-01-01T00:00:00.000Z", value: "Busan" },
      { at: "2026-03-01T00:00:00.000Z", value: "Seoul" }
    ]);
    expect(record?.forgottenAt).toBeUndefined();
  });

  it("sets forgottenAt when the newest event for a key is a retraction", () => {
    const entries = [
      base({ learnedAt: "2026-01-01T00:00:00.000Z", value: "Busan" }),
      base({ learnedAt: "2026-02-01T00:00:00.000Z", retraction: true, value: "" })
    ];
    const [record] = factRecordsFromProvenance(entries);
    expect(record?.forgottenAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("does not set forgottenAt when a later re-set clears the retraction", () => {
    const entries = [
      base({ learnedAt: "2026-01-01T00:00:00.000Z", value: "Busan" }),
      base({ learnedAt: "2026-02-01T00:00:00.000Z", retraction: true, value: "" }),
      base({ learnedAt: "2026-03-01T00:00:00.000Z", value: "Daegu" })
    ];
    const [record] = factRecordsFromProvenance(entries);
    expect(record?.forgottenAt).toBeUndefined();
    expect(record?.steps.at(-1)).toEqual({ at: "2026-03-01T00:00:00.000Z", value: "Daegu" });
  });

  it("keeps separate keys separate", () => {
    const entries = [base({ key: "home_city" }), base({ key: "role", value: "engineer" })];
    const records = factRecordsFromProvenance(entries);
    expect(records.map((r) => r.key).sort()).toEqual(["home_city", "role"]);
  });

  it("empty input produces no records", () => {
    expect(factRecordsFromProvenance([])).toEqual([]);
  });
});
