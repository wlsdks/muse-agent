import { describe, expect, it } from "vitest";

import { overdueContacts, type ContactInteractions } from "../src/relationship-decay.js";

const NOW = Date.UTC(2026, 5, 1);
const daysAgo = (d: number): number => NOW - d * 24 * 60 * 60_000;
/** A contact seen every `interval` days for `count` times, the last `lastGap` days ago. */
const cadence = (name: string, intervalDays: number, count: number, lastGapDays: number): ContactInteractions => ({
  name,
  timestampsMs: Array.from({ length: count }, (_, i) => daysAgo(lastGapDays + (count - 1 - i) * intervalDays))
});

describe("overdueContacts — Dunbar tie-strength decay (personalised cadence)", () => {
  it("flags a weekly friend gone a month, NOT a yearly cousin gone two months", () => {
    const weeklyFriend = cadence("Mina", 7, 6, 35);   // 7d cadence, last seen 35d ago → ~5× overdue
    const yearlyCousin = cadence("Sam", 365, 3, 60);   // ~yearly cadence, last 60d ago → not overdue
    const overdue = overdueContacts([weeklyFriend, yearlyCousin], { nowMs: NOW });
    expect(overdue.map((c) => c.name)).toEqual(["Mina"]);
    expect(overdue[0]!.overdueRatio).toBeGreaterThan(2.5);
  });

  it("does NOT flag a contact seen within their usual cadence", () => {
    const recent = cadence("Bob", 14, 5, 10); // 14d cadence, last 10d ago → on schedule
    expect(overdueContacts([recent], { nowMs: NOW })).toEqual([]);
  });

  it("never nags below minGapDays even if the cadence is tiny", () => {
    const daily = cadence("Chat", 1, 10, 6); // 1d cadence, 6d gap = 6× overdue, but only 6 days
    expect(overdueContacts([daily], { nowMs: NOW })).toEqual([]); // minGapDays 14 guards
    expect(overdueContacts([daily], { nowMs: NOW, minGapDays: 3 }).map((c) => c.name)).toEqual(["Chat"]);
  });

  it("skips a contact with too few interactions to estimate a cadence", () => {
    expect(overdueContacts([{ name: "New", timestampsMs: [daysAgo(40), daysAgo(2)] }], { nowMs: NOW })).toEqual([]); // only 2 → 1 gap < minInteractions 3
  });

  it("ranks most-overdue first and caps the list", () => {
    const a = cadence("A", 7, 5, 70);   // ~10× overdue
    const b = cadence("B", 7, 5, 35);   // ~5× overdue
    const ranked = overdueContacts([b, a], { nowMs: NOW });
    expect(ranked.map((c) => c.name)).toEqual(["A", "B"]);
    expect(overdueContacts([a, b], { nowMs: NOW, maxResults: 1 })).toHaveLength(1);
  });

  it("reports the personalised cadence + gap for the nudge message", () => {
    const [mina] = overdueContacts([cadence("Mina", 7, 6, 35)], { nowMs: NOW });
    expect(mina!.cadenceDays).toBeCloseTo(7, 0);
    expect(mina!.gapDays).toBeCloseTo(35, 0);
  });

  it("counts contact OCCASIONS not message volume — a bursty same-day conversation is one contact", () => {
    const HOUR = 3_600_000;
    // weekly occasions (5, last 35d ago), but each is a 3-message same-UTC-day
    // burst. Without same-day collapse the intra-day ~0 gaps drag the median
    // cadence to ~0.04d (nonsense) instead of the true 7d.
    const bursty: ContactInteractions = {
      name: "Burst",
      timestampsMs: [63, 56, 49, 42, 35].flatMap((g) => [daysAgo(g), daysAgo(g) + HOUR, daysAgo(g) + 2 * HOUR])
    };
    const [out] = overdueContacts([bursty], { nowMs: NOW });
    expect(out!.cadenceDays).toBeCloseTo(7, 0); // true occasion cadence, not message spacing
    const [clean] = overdueContacts([cadence("Clean", 7, 5, 35)], { nowMs: NOW });
    expect(out!.cadenceDays).toBeCloseTo(clean!.cadenceDays, 1); // == single-stamp-per-occasion equivalent
  });
});
