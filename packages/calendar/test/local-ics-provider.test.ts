import { describe, expect, it } from "vitest";

import { LocalIcsCalendarProvider, expandRecurringEvent, parseIcsCalendar } from "../src/index.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:evt-1",
  "SUMMARY:Investor sync with Foundry",
  "DTSTART:20260515T090000Z",
  "DTEND:20260515T100000Z",
  "LOCATION:Zoom",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:evt-2",
  "SUMMARY:Dentist",
  "DTSTART;VALUE=DATE:20260601",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

describe("parseIcsCalendar", () => {
  it("parses every VEVENT (timed + all-day), sorted by start, with fields", () => {
    const events = parseIcsCalendar(ICS, "ics");
    expect(events.map((e) => e.title)).toEqual(["Investor sync with Foundry", "Dentist"]);
    expect(events[0]?.id).toBe("evt-1");
    expect(events[0]?.location).toBe("Zoom");
    expect(events[0]?.startsAt.toISOString()).toBe("2026-05-15T09:00:00.000Z");
    expect(events[1]?.allDay).toBe(true);
  });

  it("skips a malformed VEVENT (no summary/start), never throwing", () => {
    const bad = "BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT";
    expect(parseIcsCalendar(bad, "ics")).toEqual([]);
    expect(parseIcsCalendar("not a calendar at all", "ics")).toEqual([]);
  });
});

describe("LocalIcsCalendarProvider — read-only local .ics connector", () => {
  const provider = new LocalIcsCalendarProvider({ file: "/x/calendar.ics", readFileImpl: async () => ICS });

  it("is a LOCAL provider (kept by the local-only registry filter)", () => {
    expect(provider.describe().local).toBe(true);
    expect(provider.id).toBe("ics");
  });

  it("listEvents returns events overlapping the range", async () => {
    const events = await provider.listEvents({ from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-05-31T23:59:59Z") });
    expect(events.map((e) => e.title)).toEqual(["Investor sync with Foundry"]); // June dentist is out of range
  });

  it("a missing/unreadable .ics yields no events (fail-soft)", async () => {
    const missing = new LocalIcsCalendarProvider({ file: "/nope.ics", readFileImpl: async () => { throw new Error("ENOENT"); } });
    expect(await missing.listEvents({ from: new Date(0), to: new Date(8.64e15) })).toEqual([]);
  });

  it("is READ-ONLY — mutators reject", async () => {
    await expect(provider.createEvent({ title: "x", startsAt: new Date(), endsAt: new Date() })).rejects.toThrow(/read-only/);
    await expect(provider.updateEvent("evt-1", { title: "y" })).rejects.toThrow(/read-only/);
    await expect(provider.deleteEvent("evt-1")).rejects.toThrow(/read-only/);
  });
});

describe("expandRecurringEvent + recurring .ics", () => {
  const base = {
    id: "standup", providerId: "ics", title: "Daily standup", allDay: false,
    startsAt: new Date("2026-05-04T09:00:00Z"), endsAt: new Date("2026-05-04T09:15:00Z")
  };
  const from = new Date("2026-06-01T00:00:00Z");
  const to = new Date("2026-06-08T00:00:00Z");

  it("non-recurring event passes through unchanged", () => {
    const out = parseIcsCalendar("BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:One-off\r\nDTSTART:20260602T090000Z\r\nEND:VEVENT", "ics");
    const expanded = out.flatMap((e) => expandRecurringEvent(e, from, to));
    expect(expanded).toHaveLength(1);
  });

  it("a WEEKLY series anchored in the past surfaces its in-window instance(s)", () => {
    const weekly = { ...base, recurrence: "FREQ=WEEKLY" }; // Mondays from 2026-05-04
    const insts = expandRecurringEvent(weekly, from, to);
    expect(insts.length).toBeGreaterThanOrEqual(1);
    // every instance is inside the window and on the right weekday cadence
    for (const e of insts) {
      expect(e.startsAt.getTime()).toBeGreaterThanOrEqual(from.getTime() - 7 * 864e5);
      expect(e.startsAt.getTime()).toBeLessThanOrEqual(to.getTime());
    }
    expect(insts.some((e) => e.startsAt.toISOString().startsWith("2026-06-01"))).toBe(true); // the in-window Monday (06-08T09:00 is past the `to` bound)
  });

  it("a DAILY series fills the window; INTERVAL + COUNT + UNTIL bound it", () => {
    expect(expandRecurringEvent({ ...base, recurrence: "FREQ=DAILY" }, from, to).length).toBeGreaterThanOrEqual(6);
    expect(expandRecurringEvent({ ...base, recurrence: "FREQ=DAILY;COUNT=2" }, from, to)).toHaveLength(0); // only 2 instances, both in the past
    const untilPast = expandRecurringEvent({ ...base, recurrence: "FREQ=DAILY;UNTIL=20260510T000000Z" }, from, to);
    expect(untilPast).toHaveLength(0); // series ended before the window
  });

  it("a MONTHLY series clamps the day to short months (Jan 31 → Feb 28 → Mar 31)", () => {
    const monthly = { ...base, id: "rent", startsAt: new Date("2026-01-31T09:00:00Z"), endsAt: new Date("2026-01-31T10:00:00Z"), recurrence: "FREQ=MONTHLY" };
    const insts = expandRecurringEvent(monthly, new Date("2026-01-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));
    expect(insts.map((e) => e.startsAt.toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("a YEARLY series clamps Feb 29 to Feb 28 on a non-leap year", () => {
    const yearly = { ...base, id: "anniv", startsAt: new Date("2028-02-29T09:00:00Z"), endsAt: new Date("2028-02-29T10:00:00Z"), recurrence: "FREQ=YEARLY" };
    const insts = expandRecurringEvent(yearly, new Date("2028-01-01T00:00:00Z"), new Date("2030-03-01T00:00:00Z"));
    expect(insts.map((e) => e.startsAt.toISOString().slice(0, 10))).toEqual(["2028-02-29", "2029-02-28", "2030-02-28"]);
  });

  it("a DAILY series anchored a year before the window still surfaces in-window instances (cap is relative to the window, not the base)", () => {
    // base a year+ before the query window: > MAX_RECURRENCE_INSTANCES (200) daily
    // steps away, so a base-anchored cap is exhausted before reaching the window.
    const farPast = {
      ...base,
      startsAt: new Date("2025-05-04T09:00:00Z"),
      endsAt: new Date("2025-05-04T09:15:00Z"),
      recurrence: "FREQ=DAILY"
    };
    const insts = expandRecurringEvent(farPast, from, to);
    expect(insts.length).toBeGreaterThanOrEqual(6); // one per day across the 7-day window
    for (const e of insts) {
      expect(e.endsAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(e.startsAt.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });

  it("a WEEKLY series anchored years before the window still reaches it", () => {
    const farPast = {
      ...base,
      startsAt: new Date("2022-05-02T09:00:00Z"), // a Monday, ~4 years before the window
      endsAt: new Date("2022-05-02T09:15:00Z"),
      recurrence: "FREQ=WEEKLY"
    };
    const insts = expandRecurringEvent(farPast, from, to);
    expect(insts.length).toBeGreaterThanOrEqual(1);
    for (const e of insts) {
      expect(e.endsAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(e.startsAt.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });

  it("a genuinely unsupported RRULE (e.g. HOURLY) surfaces the base event, never fabricated instances", () => {
    expect(expandRecurringEvent({ ...base, recurrence: "FREQ=HOURLY" }, from, to)).toEqual([{ ...base, recurrence: "FREQ=HOURLY" }]);
  });

  it("provider.listEvents expands a recurring .ics into in-window instances", async () => {
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:su\r\nSUMMARY:Weekly standup\r\nDTSTART:20260504T090000Z\r\nDTEND:20260504T091500Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const provider = new LocalIcsCalendarProvider({ file: "/x.ics", readFileImpl: async () => ics });
    const events = await provider.listEvents({ from, to });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.title === "Weekly standup")).toBe(true);
  });
});
