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

  it("honours a TZID IANA zone, converting wall-clock to the correct UTC instant (incl. DST)", () => {
    // America/New_York: EST (UTC-5) in January, EDT (UTC-4) in July.
    const [winter] = parseIcsEvents(
      vevent(["SUMMARY:NY winter", "DTSTART;TZID=America/New_York:20260118T090000"])
    );
    expect(winter?.startsAt.toISOString()).toBe("2026-01-18T14:00:00.000Z");
    const [summer] = parseIcsEvents(
      vevent(["SUMMARY:NY summer", "DTSTART;TZID=America/New_York:20260718T090000"])
    );
    expect(summer?.startsAt.toISOString()).toBe("2026-07-18T13:00:00.000Z");
    // Asia/Seoul: UTC+9, no DST.
    const [seoul] = parseIcsEvents(
      vevent(["SUMMARY:Seoul", "DTSTART;TZID=Asia/Seoul:20260315T090000"])
    );
    expect(seoul?.startsAt.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("accepts a quoted TZID and lets a Z suffix win over any TZID", () => {
    const [quoted] = parseIcsEvents(
      vevent(["SUMMARY:Q", `DTSTART;TZID="America/New_York":20260118T090000`])
    );
    expect(quoted?.startsAt.toISOString()).toBe("2026-01-18T14:00:00.000Z");
    const [zWins] = parseIcsEvents(
      vevent(["SUMMARY:Z", "DTSTART;TZID=America/New_York:20260118T090000Z"])
    );
    expect(zWins?.startsAt.toISOString()).toBe("2026-01-18T09:00:00.000Z");
  });

  it("falls back to the UTC reading for an unknown TZID rather than dropping the event", () => {
    const [ev] = parseIcsEvents(
      vevent(["SUMMARY:Bad zone", "DTSTART;TZID=Mars/Phobos:20260118T090000"])
    );
    expect(ev?.startsAt.toISOString()).toBe("2026-01-18T09:00:00.000Z");
  });

  it("drops an impossible calendar date instead of silently rolling it over", () => {
    // Date.UTC(2026, 1, 30) rolls Feb 30 → Mar 2; an importer must
    // not put the event on the wrong day. Both forms must reject.
    for (const dtstart of [
      "DTSTART;VALUE=DATE:20260230", // Feb 30
      "DTSTART;VALUE=DATE:20261345", // month 13 / day 45
      "DTSTART:20260230T120000Z",    // Feb 30, timed
      "DTSTART:20260118T250000Z",    // hour 25
      "DTSTART:20260118T006099Z"     // minute 60 / second 99
    ]) {
      expect(parseIcsEvents(vevent(["SUMMARY:Bad", dtstart]))).toEqual([]);
    }

    // No regression: a genuine leap day and an ordinary date still parse.
    const [leap] = parseIcsEvents(vevent(["SUMMARY:Leap", "DTSTART;VALUE=DATE:20280229"]));
    expect(leap?.startsAt.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    const [ok] = parseIcsEvents(vevent(["SUMMARY:OK", "DTSTART:20261231T235959Z"]));
    expect(ok?.startsAt.toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });
});
