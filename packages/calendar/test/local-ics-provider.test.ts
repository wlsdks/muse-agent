import { describe, expect, it } from "vitest";

import { LocalIcsCalendarProvider, parseIcsCalendar } from "../src/index.js";

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
