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
});
