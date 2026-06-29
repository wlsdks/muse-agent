import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nextReminderOccurrence } from "../src/personal-reminders-store.js";

// DST drift only shows in a DST-observing zone; pin one (KST has none). Node honours a runtime
// process.env.TZ change for Date ops — the mutation drill proves the override is effective.
const ORIG_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => { process.env.TZ = ORIG_TZ; });

const hourOf = (iso: string): number => new Date(iso).getHours();

describe("nextReminderOccurrence — daily/weekly recurrence is DST-safe (wall-clock preserved)", () => {
  it("a daily 09:00 reminder keeps 09:00 across the US spring-forward (Mar 8 2026)", () => {
    let due = new Date(2026, 2, 6, 9, 0).toISOString(); // Fri Mar 6 09:00
    for (let i = 0; i < 5; i += 1) {
      const next = nextReminderOccurrence(due, "daily", due);
      expect(hourOf(next)).toBe(9); // flat-ms would drift to 10 after Mar 8
      due = next;
    }
  });
  it("a weekly reminder preserves its hour across the DST boundary", () => {
    const due = new Date(2026, 2, 2, 8, 30).toISOString();
    expect(hourOf(nextReminderOccurrence(due, "weekly", due))).toBe(8);
    expect(new Date(nextReminderOccurrence(due, "weekly", due)).getMinutes()).toBe(30);
  });
  it("still skips periods missed during downtime (advances strictly past `from`)", () => {
    const due = new Date(2026, 2, 6, 9, 0).toISOString();
    const from = new Date(2026, 2, 9, 21, 0).toISOString(); // 3+ days later
    const next = nextReminderOccurrence(due, "daily", from);
    expect(new Date(next).getTime()).toBeGreaterThan(new Date(from).getTime());
    expect(hourOf(next)).toBe(9);
    expect(new Date(next).getDate()).toBe(10); // Mar 10 09:00 (first occurrence after Mar 9 21:00)
  });
});
