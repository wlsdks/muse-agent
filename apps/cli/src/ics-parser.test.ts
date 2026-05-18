import { describe, expect, it } from "vitest";

import { parseIcsEvents } from "./ics-parser.js";

const CRLF = "\r\n";
const BS = String.fromCharCode(92); // a single backslash

function vevent(lines: readonly string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join(CRLF);
}

describe("parseIcsEvents", () => {
  it("parses a timed VEVENT and defaults a missing DTEND to +30 min", () => {
    const [ev] = parseIcsEvents(
      vevent(["SUMMARY:Sync", "DTSTART:20260118T090000Z", "UID:u1"])
    );
    expect(ev?.title).toBe("Sync");
    expect(ev?.allDay).toBe(false);
    expect(ev?.startsAt.toISOString()).toBe("2026-01-18T09:00:00.000Z");
    expect(ev?.endsAt.toISOString()).toBe("2026-01-18T09:30:00.000Z");
    expect(ev?.uid).toBe("u1");
  });

  it("treats VALUE=DATE as an all-day event (UTC midnight, +1 day end)", () => {
    const [ev] = parseIcsEvents(
      vevent(["SUMMARY:Holiday", "DTSTART;VALUE=DATE:20260118"])
    );
    expect(ev?.allDay).toBe(true);
    expect(ev?.startsAt.toISOString()).toBe("2026-01-18T00:00:00.000Z");
    expect(ev?.endsAt.toISOString()).toBe("2026-01-19T00:00:00.000Z");
  });

  it("unfolds RFC 5545 continuation lines (leading space / tab)", () => {
    const [ev] = parseIcsEvents(
      vevent(["SUMMARY:Long ti", "\ttle here", "DTSTART:20260118T100000Z"])
    );
    expect(ev?.title).toBe("Long title here");
  });

  it("skips malformed blocks and returns the rest sorted by startsAt", () => {
    const body = [
      vevent(["SUMMARY:B", "DTSTART:20260120T090000Z"]),
      vevent(["SUMMARY:NoStart"]),
      vevent(["SUMMARY:A", "DTSTART:20260119T090000Z"])
    ].join(CRLF);
    const events = parseIcsEvents(body);
    expect(events.map((e) => e.title)).toEqual(["A", "B"]);
  });

  it("returns no events for an empty or non-iCal body", () => {
    expect(parseIcsEvents("")).toEqual([]);
    expect(parseIcsEvents("not an ics at all")).toEqual([]);
  });

  it("unescapes TEXT in a single RFC 5545 pass — \\\\n is backslash+n, not a newline", () => {
    // Raw iCal DESCRIPTION value: A \\ n B \n C
    //   \\ -> backslash, then literal 'n'  => "\n" (two chars)
    //   \n -> a real newline
    const descRaw = `A${BS}${BS}nB${BS}nC`;
    const locRaw = `Rm${BS},5${BS};x`;
    const [ev] = parseIcsEvents(
      vevent([
        "SUMMARY:Hi",
        "DTSTART:20260118T090000Z",
        `DESCRIPTION:${descRaw}`,
        `LOCATION:${locRaw}`
      ])
    );
    expect(ev?.notes).toBe(`A${BS}nB\nC`);
    expect([...(ev?.notes ?? "")].map((c) => c.charCodeAt(0)))
      .toEqual([65, 92, 110, 66, 10, 67]);
    expect(ev?.location).toBe("Rm,5;x");
  });
});
