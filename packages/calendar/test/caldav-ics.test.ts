import { describe, expect, it } from "vitest";

import { parseVEvent, renderCalendarQueryReport, renderVEvent } from "../src/caldav-ics.js";

describe("caldav-ics — renderVEvent ↔ parseVEvent round-trip", () => {
  it("preserves a timed event's title, instants, and location through ICS", () => {
    const ics = renderVEvent("evt-1", {
      title: "Q3 Review",
      startsAt: new Date("2026-06-14T18:00:00Z"),
      endsAt: new Date("2026-06-14T19:00:00Z"),
      location: "Room 4"
    });
    expect(ics).toContain("SUMMARY:Q3 Review");
    const parsed = parseVEvent(ics, "caldav", "fallback-id");
    expect(parsed).toBeDefined();
    expect(parsed!.title).toBe("Q3 Review");
    expect(parsed!.location).toBe("Room 4");
    expect(parsed!.startsAt.getTime()).toBe(new Date("2026-06-14T18:00:00Z").getTime());
    expect(parsed!.endsAt.getTime()).toBe(new Date("2026-06-14T19:00:00Z").getTime());
    expect(parsed!.allDay).toBe(false);
  });

  it("preserves the all-day flag (DATE not DATE-TIME)", () => {
    const ics = renderVEvent("evt-2", {
      title: "Holiday",
      startsAt: new Date("2026-06-14T00:00:00Z"),
      endsAt: new Date("2026-06-15T00:00:00Z"),
      allDay: true
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:");
    const parsed = parseVEvent(ics, "caldav", "fb");
    expect(parsed!.allDay).toBe(true);
  });

  it("returns undefined when there is no parseable VEVENT", () => {
    expect(parseVEvent("this is not an ics document", "caldav", "fb")).toBeUndefined();
  });
});

describe("caldav-ics — renderCalendarQueryReport", () => {
  it("emits a CalDAV calendar-query REPORT scoped to the time range", () => {
    const xml = renderCalendarQueryReport({
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-30T00:00:00Z")
    });
    expect(xml).toContain("calendar-query");
    expect(xml).toContain("VEVENT");
  });
});
