import { describe, expect, it } from "vitest";

import { eventsToIcs, type IcsEvent } from "../src/ics-export.js";

const NOW = new Date("2026-05-01T00:00:00.000Z");

describe("eventsToIcs", () => {
  it("wraps timed events in a VCALENDAR with UTC DTSTART/DTEND", () => {
    const events: IcsEvent[] = [
      {
        id: "e1",
        title: "Standup",
        startsAt: new Date("2026-06-01T09:00:00.000Z"),
        endsAt: new Date("2026-06-01T09:30:00.000Z"),
        location: "Zoom"
      }
    ];
    const ics = eventsToIcs(events, { now: NOW });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("UID:e1@muse");
    expect(ics).toContain("SUMMARY:Standup");
    expect(ics).toContain("DTSTART:20260601T090000Z");
    expect(ics).toContain("DTEND:20260601T093000Z");
    expect(ics).toContain("LOCATION:Zoom");
    expect(ics).toContain("DTSTAMP:20260501T000000Z");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("renders an all-day event with VALUE=DATE", () => {
    const ics = eventsToIcs(
      [{ id: "h1", title: "Holiday", startsAt: new Date("2026-12-25T00:00:00Z"), endsAt: new Date("2026-12-26T00:00:00Z"), allDay: true }],
      { now: NOW }
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261225");
    expect(ics).toContain("DTEND;VALUE=DATE:20261226");
    expect(ics).not.toContain("DTSTART:2026");
  });

  it("escapes ICS special characters in text fields", () => {
    const ics = eventsToIcs(
      [{ id: "x", title: "Lunch; with A, B", startsAt: new Date("2026-06-01T12:00:00Z"), endsAt: new Date("2026-06-01T13:00:00Z"), notes: "line1\nline2" }],
      { now: NOW }
    );
    expect(ics).toContain("SUMMARY:Lunch\\; with A\\, B");
    expect(ics).toContain("DESCRIPTION:line1\\nline2");
  });

  it("doubles a literal backslash FIRST so it isn't re-escaped (RFC 5545 ordering)", () => {
    // The backslash escape must run before ; , \n — otherwise the backslashes
    // those add would themselves get doubled. A Windows-path title is the case.
    const ics = eventsToIcs(
      [{ id: "p", title: "path C:\\temp\\logs", startsAt: new Date("2026-06-01T12:00:00Z"), endsAt: new Date("2026-06-01T13:00:00Z") }],
      { now: NOW }
    );
    expect(ics).toContain("SUMMARY:path C:\\\\temp\\\\logs"); // each \ → \\, not over-escaped
  });

  it("emits a valid empty calendar for no events", () => {
    const ics = eventsToIcs([], { now: NOW });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
