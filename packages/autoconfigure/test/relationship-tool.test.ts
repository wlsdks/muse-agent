import { type ContactInteractions } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { createOverdueContactsTool, interactionsFromEvents } from "../src/index.js";

const DAY = 86_400_000;
const NOW = new Date("2026-06-13T00:00:00Z");
const nowMs = NOW.getTime();

const INTERACTIONS: ContactInteractions[] = [
  // Bob: ~weekly cadence, last seen 60 days ago → overdue (60/7 ≈ 8.6 > 2.5, gap ≥ 14)
  { name: "Bob", timestampsMs: [nowMs - 81 * DAY, nowMs - 74 * DAY, nowMs - 67 * DAY, nowMs - 60 * DAY] },
  // Alice: ~weekly, seen 3 days ago → NOT overdue (gap 3 < minGapDays 14)
  { name: "Alice", timestampsMs: [nowMs - 17 * DAY, nowMs - 10 * DAY, nowMs - 3 * DAY] }
];

function tool(interactions: ContactInteractions[] = INTERACTIONS) {
  return createOverdueContactsTool({ interactions: () => interactions, now: () => NOW });
}

describe("createOverdueContactsTool — who you've lost touch with", () => {
  it("is risk:read and surfaces only the overdue contact, ranked, with gap/cadence (value flows through overdueContacts)", async () => {
    const t = tool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({}) as { count: number; overdue: { name: string; gapDays: number; cadenceDays: number; overdueRatio: number }[] };
    expect(out.count).toBe(1);
    expect(out.overdue.map((o) => o.name)).toEqual(["Bob"]);
    expect(out.overdue[0]?.gapDays).toBe(60);
    expect(out.overdue[0]?.cadenceDays).toBe(7);
    expect(out.overdue[0]?.overdueRatio).toBeGreaterThan(2.5);
    expect(out.overdue.map((o) => o.name)).not.toContain("Alice"); // seen recently → not nudged
  });

  it("returns count 0 when no one is overdue", async () => {
    const out = await tool([{ name: "Alice", timestampsMs: [nowMs - 17 * DAY, nowMs - 10 * DAY, nowMs - 3 * DAY] }]).execute({}) as { count: number; overdue: unknown[] };
    expect(out.count).toBe(0);
    expect(out.overdue).toEqual([]);
  });

  it("respects an optional limit", async () => {
    const out = await tool().execute({ limit: 1 }) as { overdue: unknown[] };
    expect(out.overdue.length).toBeLessThanOrEqual(1);
  });
});

describe("interactionsFromEvents — derive contact interaction timestamps from event mentions (moved from CLI)", () => {
  it("matches a contact name/alias in event text and collects the event times", () => {
    const events = [
      { startsAt: "2026-05-01T10:00:00Z", title: "Standup with Mina" },
      { startsAt: "2026-05-08T10:00:00Z", title: "Lunch w/ Mimi" }, // alias
      { startsAt: "2026-05-02T10:00:00Z", title: "Dentist" } // no mention
    ];
    const [mina] = interactionsFromEvents([{ aliases: ["Mimi"], name: "Mina" }], events);
    expect(mina?.timestampsMs).toHaveLength(2);
  });

  it("drops an event with an unparseable startsAt even when its text mentions the contact", () => {
    const events = [
      { startsAt: "not-a-real-date", title: "Standup with Mina" },
      { startsAt: "2026-05-01T10:00:00Z", title: "Coffee with Mina" }
    ];
    const [mina] = interactionsFromEvents([{ name: "Mina" }], events);
    expect(mina?.timestampsMs).toEqual([Date.parse("2026-05-01T10:00:00Z")]);
  });

  it("does NOT count an event whose text merely CONTAINS an ASCII name as a substring (no false interaction)", () => {
    // "ann" ⊂ "pl·ann·ing", "sam" ⊂ "·Sam·sung" — these are NOT interactions with
    // Ann / Sam. A substring match would inject a spurious recent timestamp and
    // (downstream) drop a genuinely-overdue contact from the nudge.
    const events = [
      { startsAt: "2026-06-01T10:00:00Z", title: "Planning review" },
      { startsAt: "2026-06-02T10:00:00Z", title: "Samsung product launch" }
    ];
    expect(interactionsFromEvents([{ name: "Ann" }], events)[0]?.timestampsMs).toEqual([]);
    expect(interactionsFromEvents([{ name: "Sam" }], events)[0]?.timestampsMs).toEqual([]);
  });

  it("still matches a genuine whole-word ASCII mention and a Korean name with an attached particle", () => {
    const events = [
      { startsAt: "2026-06-03T10:00:00Z", title: "Lunch with Ann" }, // EN whole word
      { startsAt: "2026-06-04T10:00:00Z", title: "민지랑 저녁" } // KO name + 조사 (particle attaches directly)
    ];
    expect(interactionsFromEvents([{ name: "Ann" }], events)[0]?.timestampsMs).toEqual([Date.parse("2026-06-03T10:00:00Z")]);
    expect(interactionsFromEvents([{ name: "민지" }], events)[0]?.timestampsMs).toEqual([Date.parse("2026-06-04T10:00:00Z")]);
  });

  it("a substring-colliding event does NOT drop a genuinely-overdue contact (terminal state through the tool)", async () => {
    // Ann: genuine ~weekly cadence, last REAL mention 60d ago → overdue. A recent
    // unrelated "Planning review" must not collapse her gap to ~0 and hide her.
    const events = [
      { startsAt: new Date(nowMs - 81 * DAY).toISOString(), title: "Lunch with Ann" },
      { startsAt: new Date(nowMs - 74 * DAY).toISOString(), title: "Coffee with Ann" },
      { startsAt: new Date(nowMs - 67 * DAY).toISOString(), title: "Call with Ann" },
      { startsAt: new Date(nowMs - 60 * DAY).toISOString(), title: "Dinner with Ann" },
      { startsAt: new Date(nowMs - 2 * DAY).toISOString(), title: "Planning review" } // unrelated — "ann" ⊂ "planning"
    ];
    const interactions = interactionsFromEvents([{ name: "Ann" }], events);
    const out = (await createOverdueContactsTool({ interactions: () => interactions, now: () => NOW }).execute({})) as {
      overdue: { name: string; gapDays: number }[];
    };
    expect(out.overdue.map((o) => o.name)).toContain("Ann");
    expect(out.overdue.find((o) => o.name === "Ann")?.gapDays).toBe(60);
  });
});
