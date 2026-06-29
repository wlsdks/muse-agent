import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expandRecurringEvent } from "../src/ics-parse.js";
import type { CalendarEvent } from "../src/types.js";

// The drift only manifests in a DST-observing zone; pin one so the test is meaningful on a
// KST (no-DST) CI box. Node picks up a runtime process.env.TZ change for Date operations.
const ORIG_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => { process.env.TZ = ORIG_TZ; });

function ev(startsAt: Date, endsAt: Date, recurrence: string): CalendarEvent {
  return { allDay: false, endsAt, id: "e1", providerId: "local", recurrence, startsAt, title: "standup" };
}

describe("expandRecurringEvent — daily/weekly recurrence is DST-safe (wall-clock time preserved)", () => {
  it("a daily 10:00 event stays at 10:00 across the US spring-forward (Mar 8 2026)", () => {
    const out = expandRecurringEvent(ev(new Date(2026, 2, 6, 10, 0), new Date(2026, 2, 6, 10, 30), "FREQ=DAILY"), new Date(2026, 2, 6), new Date(2026, 2, 12));
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const o of out) expect(o.startsAt.getHours()).toBe(10); // flat-ms stepping would give 11 after Mar 8
  });
  it("a weekly 09:00 event keeps its hour across the DST boundary", () => {
    const out = expandRecurringEvent(ev(new Date(2026, 2, 2, 9, 0), new Date(2026, 2, 2, 9, 30), "FREQ=WEEKLY"), new Date(2026, 2, 2), new Date(2026, 2, 30));
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const o of out) expect(o.startsAt.getHours()).toBe(9);
  });
});
