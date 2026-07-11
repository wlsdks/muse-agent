import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chmodSync } from "node:fs";

import {
  CalDAVCalendarProvider,
  CalendarProviderError,
  CalendarProviderRegistry,
  CalendarValidationError,
  FileCalendarCredentialStore,
  GoogleCalendarProvider,
  LocalCalendarProvider,
  MacOsCalendarProvider,
  isRetryableCalendarStatus,
  type CalendarEvent,
  type CalendarProvider
} from "../src/index.js";

describe.skipIf(process.platform === "win32")("MacOsCalendarProvider osascript spawn timeout", () => {
  function hungScript(): string {
    const dir = mkdtempSync(join(tmpdir(), "muse-osascript-hang-"));
    const script = join(dir, "fake-osascript");
    // Real executable that never exits and ignores stdin — proves
    // the watchdog kills it, not the test merely timing out.
    writeFileSync(script, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
    chmodSync(script, 0o755);
    return script;
  }

  it("SIGKILLs a wedged osascript and rejects OSASCRIPT_TIMEOUT (no infinite hang)", async () => {
    const provider = new MacOsCalendarProvider({ osascriptPath: hungScript(), timeoutMs: 150 });
    const start = Date.now();
    await expect(
      provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) })
    ).rejects.toMatchObject({ code: "OSASCRIPT_TIMEOUT" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("resolves normally for a fast-exiting osascript (empty event list)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-osascript-ok-"));
    const ok = join(dir, "fake-osascript");
    writeFileSync(ok, `#!${process.execPath}\nprocess.exit(0);\n`);
    chmodSync(ok, 0o755);
    const provider = new MacOsCalendarProvider({ osascriptPath: ok, timeoutMs: 10_000 });
    await expect(
      provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) })
    ).resolves.toEqual([]);
  });

  it("parses the all-day flag from the osascript output (was hardcoded false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-osascript-allday-"));
    const bin = join(dir, "fake-osascript");
    // Emit two tab-delimited records: a timed event (allday "false")
    // and an all-day event (allday "true"), matching the list query's
    // `id \t start \t end \t title \t loc \t allday` shape.
    const lines = [
      "evt-timed\t2026-05-20T09:00:00Z\t2026-05-20T10:00:00Z\tStandup\t\tfalse",
      "evt-allday\t2026-05-21T00:00:00Z\t2026-05-22T00:00:00Z\tConference\tHall A\ttrue"
    ].join("\\n");
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write("${lines}\\n");\nprocess.exit(0);\n`);
    chmodSync(bin, 0o755);
    const provider = new MacOsCalendarProvider({ osascriptPath: bin, timeoutMs: 10_000 });
    const events = await provider.listEvents({ from: new Date(0), to: new Date("2027-01-01T00:00:00Z") });
    expect(events.map((e) => ({ allDay: e.allDay, id: e.id }))).toEqual([
      { allDay: false, id: "evt-timed" },
      { allDay: true, id: "evt-allday" }
    ]);
    expect(events.find((e) => e.id === "evt-allday")?.location).toBe("Hall A");
  });
});

describe("CalDAVCalendarProvider ICS time parsing", () => {
  function providerReturning(ics: string): CalDAVCalendarProvider {
    const xml =
      `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<D:response><D:href>/dav/evt.ics</D:href><D:propstat><D:prop>` +
      `<C:calendar-data>${ics}</C:calendar-data></D:prop></D:propstat></D:response>` +
      `</D:multistatus>`;
    return new CalDAVCalendarProvider({
      fetchImpl: async () => new Response(xml, { status: 200 }),
      password: "p",
      url: "https://cal.test/dav/",
      username: "u"
    });
  }

  const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") };

  it("resolves a TZID-qualified DTSTART to the correct UTC instant", async () => {
    const ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ny-1", "SUMMARY:NY meeting",
      "DTSTART;TZID=America/New_York:20260517T100000",
      "DTEND;TZID=America/New_York:20260517T110000",
      "END:VEVENT", "END:VCALENDAR"
    ].join("\n");
    const [event] = await providerReturning(ics).listEvents(range);
    // 2026-05-17 is EDT (UTC-4): 10:00 New York == 14:00 UTC.
    expect(event?.startsAt.toISOString()).toBe("2026-05-17T14:00:00.000Z");
    expect(event?.endsAt.toISOString()).toBe("2026-05-17T15:00:00.000Z");
  });

  it("ignores a VTIMEZONE DTSTART preceding the VEVENT (real-world TZID emission)", async () => {
    // Real CalDAV servers inline the VTIMEZONE for a TZID-qualified
    // event, before the VEVENT. Its DST-rule DTSTART must NOT be
    // read as the event's start.
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE", "TZID:America/New_York",
      "BEGIN:DAYLIGHT", "DTSTART:20070311T020000",
      "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "BEGIN:STANDARD", "DTSTART:20071104T020000",
      "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:tz-1", "SUMMARY:NY meeting",
      "DTSTART;TZID=America/New_York:20260517T100000",
      "DTEND;TZID=America/New_York:20260517T110000",
      "END:VEVENT", "END:VCALENDAR"
    ].join("\n");
    const [event] = await providerReturning(ics).listEvents(range);
    expect(event?.id).toBe("tz-1");
    expect(event?.title).toBe("NY meeting");
    // The event's real start (10:00 EDT == 14:00 UTC), NOT the
    // 2007 DAYLIGHT-rule DTSTART from the VTIMEZONE.
    expect(event?.startsAt.toISOString()).toBe("2026-05-17T14:00:00.000Z");
    expect(event?.endsAt.toISOString()).toBe("2026-05-17T15:00:00.000Z");
  });

  it("keeps an explicit Z (UTC) DTSTART and an all-day DATE unchanged", async () => {
    const zEvent = [
      "BEGIN:VEVENT", "UID:z-1", "SUMMARY:UTC call",
      "DTSTART:20260517T100000Z", "DTEND:20260517T110000Z", "END:VEVENT"
    ].join("\n");
    const [z] = await providerReturning(zEvent).listEvents(range);
    expect(z?.startsAt.toISOString()).toBe("2026-05-17T10:00:00.000Z");

    const allDay = [
      "BEGIN:VEVENT", "UID:ad-1", "SUMMARY:Holiday",
      "DTSTART;VALUE=DATE:20260517", "DTEND;VALUE=DATE:20260518", "END:VEVENT"
    ].join("\n");
    const [a] = await providerReturning(allDay).listEvents(range);
    expect(a?.allDay).toBe(true);
    expect(a?.startsAt.toISOString()).toBe("2026-05-17T00:00:00.000Z");
  });

  it("unfolds RFC 5545 folded SUMMARY / LOCATION / DESCRIPTION instead of truncating at the fold", async () => {
    // Real CalDAV servers (Google, Nextcloud, Radicale) fold any
    // content line past 75 octets with CRLF + a single space.
    const ics =
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fold-1\r\n" +
      "SUMMARY:Quarterly planning sync with the platform team and stak\r\n eholders (room B)\r\n" +
      "LOCATION:Building 4\\, Floor 2\\, the big confe\r\n rence room\r\n" +
      "DTSTART:20260517T100000Z\r\nDTEND:20260517T110000Z\r\n" +
      "DESCRIPTION:agenda line one \r\n\tcontinued via a TAB fold too\r\n" +
      "END:VEVENT\r\nEND:VCALENDAR";
    const [event] = await providerReturning(ics).listEvents(range);
    expect(event?.title).toBe("Quarterly planning sync with the platform team and stakeholders (room B)");
    expect(event?.location).toBe("Building 4, Floor 2, the big conference room");
    expect(event?.notes).toBe("agenda line one continued via a TAB fold too");
    // The folded value didn't corrupt the following property.
    expect(event?.startsAt.toISOString()).toBe("2026-05-17T10:00:00.000Z");
  });

  it("falls back to a floating parse (does not drop the event) on an unknown TZID", async () => {
    const ics = [
      "BEGIN:VEVENT", "UID:bad-tz", "SUMMARY:Bad zone",
      "DTSTART;TZID=Not/AZone:20260517T100000",
      "DTEND;TZID=Not/AZone:20260517T110000", "END:VEVENT"
    ].join("\n");
    const [event] = await providerReturning(ics).listEvents(range);
    expect(event?.title).toBe("Bad zone");
    expect(Number.isNaN(event?.startsAt.getTime() ?? Number.NaN)).toBe(false);
  });
});

describe("CalDAVCalendarProvider READ — retry-with-backoff for transient failures (P19)", () => {
  const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z") };
  const eventsXml =
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:response><D:href>/dav/evt.ics</D:href><D:propstat><D:prop><C:calendar-data>` +
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:r1", "SUMMARY:Standup", "DTSTART:20260518T090000Z", "DTEND:20260518T093000Z", "END:VEVENT", "END:VCALENDAR"].join("\n") +
    `</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>`;

  function provider(responses: Array<{ status: number; body: string }>, onCall: () => void = () => {}) {
    let i = 0;
    return new CalDAVCalendarProvider({
      fetchImpl: (async () => {
        onCall();
        const r = responses[Math.min(i++, responses.length - 1)]!;
        return new Response(r.body, { status: r.status });
      }) as unknown as typeof fetch,
      password: "p",
      retry: { baseDelayMs: 0, sleep: async () => {} },
      url: "https://cal.test/dav/",
      username: "u"
    });
  }

  it("recovers from a transient 503 on the REPORT read instead of dropping the calendar", async () => {
    let calls = 0;
    const events = await provider([{ body: "", status: 503 }, { body: eventsXml, status: 200 }], () => { calls += 1; }).listEvents(range);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Standup");
    expect(calls).toBe(2);
  });

  it("a permanent 401 (bad app-password) fails fast — no retry", async () => {
    let calls = 0;
    await expect(provider([{ body: "unauthorized", status: 401 }], () => { calls += 1; }).listEvents(range)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("GoogleCalendarProvider READ — toEvent parses timed vs all-day events (contract-faithful HTTP fake)", () => {
  function providerReturning(items: unknown[]): GoogleCalendarProvider {
    return new GoogleCalendarProvider({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: (async (url: string) => {
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ items }), { status: 200 });
      }) as unknown as typeof fetch,
      refreshToken: "rtok"
    });
  }
  const range = { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-06-01T00:00:00Z") };

  it("parses a timed event by its real dateTime instant (offset-aware), allDay=false", async () => {
    const [event] = await providerReturning([
      { id: "g-timed", summary: "Standup", start: { dateTime: "2026-05-18T09:00:00-05:00" }, end: { dateTime: "2026-05-18T09:30:00-05:00" } }
    ]).listEvents(range);
    expect(event?.allDay).toBe(false);
    expect(event?.startsAt.toISOString()).toBe("2026-05-18T14:00:00.000Z"); // -05:00 → UTC
    expect(event?.endsAt.toISOString()).toBe("2026-05-18T14:30:00.000Z");
    expect(event?.title).toBe("Standup");
  });

  it("flags an all-day event (start.date, no dateTime) and reads the exclusive end date", async () => {
    const [event] = await providerReturning([
      { id: "g-allday", summary: "Conference", start: { date: "2026-05-20" }, end: { date: "2026-05-21" } }
    ]).listEvents(range);
    expect(event?.allDay).toBe(true);
    expect(event?.startsAt.toISOString()).toBe("2026-05-20T00:00:00.000Z");
    expect(event?.endsAt.toISOString()).toBe("2026-05-21T00:00:00.000Z");
  });

  it("falls back to '(untitled)' when summary is missing", async () => {
    const [event] = await providerReturning([
      { id: "g-x", start: { dateTime: "2026-05-18T09:00:00Z" }, end: { dateTime: "2026-05-18T10:00:00Z" } }
    ]).listEvents(range);
    expect(event?.title).toBe("(untitled)");
  });
});

describe("GoogleCalendarProvider READ — retry-with-backoff for transient failures (P19)", () => {
  const range = { from: new Date("2026-05-01T00:00:00Z"), to: new Date("2026-06-01T00:00:00Z") };
  const noWait = { baseDelayMs: 0, sleep: async () => {} };

  function provider(events: Array<{ status: number; body: string }>, onCall: (url: string) => void = () => {}) {
    let i = 0;
    return new GoogleCalendarProvider({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: (async (url: string) => {
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
        }
        onCall(String(url));
        const r = events[Math.min(i++, events.length - 1)]!;
        return new Response(r.body, { status: r.status });
      }) as unknown as typeof fetch,
      refreshToken: "rtok",
      retry: noWait
    });
  }

  it("recovers from a transient 503 on the events read (instead of dropping the calendar)", async () => {
    let apiCalls = 0;
    const events = await provider(
      [{ body: "", status: 503 }, { body: JSON.stringify({ items: [{ end: { dateTime: "2026-05-18T10:00:00Z" }, id: "g1", start: { dateTime: "2026-05-18T09:00:00Z" }, summary: "Standup" }] }), status: 200 }],
      (url) => { if (url.includes("/calendars/")) apiCalls += 1; }
    ).listEvents(range);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Standup");
    expect(apiCalls).toBe(2); // retried once after the 503
  });

  it("a permanent 403 fails fast (no retry) — a non-retryable status is not hammered", async () => {
    let apiCalls = 0;
    await expect(
      provider([{ body: "forbidden", status: 403 }], (url) => { if (url.includes("/calendars/")) apiCalls += 1; }).listEvents(range)
    ).rejects.toThrow();
    expect(apiCalls).toBe(1);
  });
});

describe("LocalCalendarProvider", () => {
  let dir: string;
  let provider: LocalCalendarProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-cal-"));
    provider = new LocalCalendarProvider({ file: join(dir, "calendar.json"), idFactory: counter() });
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("returns an empty list when the file does not exist", async () => {
    const events = await provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(events).toEqual([]);
  });

  it("persists recurrence and expands a weekly event into in-window instances", async () => {
    await provider.createEvent({
      endsAt: new Date("2026-06-01T09:30:00Z"),
      recurrence: "FREQ=WEEKLY",
      startsAt: new Date("2026-06-01T09:00:00Z"),
      title: "Weekly standup"
    });
    const events = await provider.listEvents({ from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-17T00:00:00Z") });
    expect(events.map((e) => e.startsAt.toISOString())).toEqual([
      "2026-06-01T09:00:00.000Z",
      "2026-06-08T09:00:00.000Z",
      "2026-06-15T09:00:00.000Z"
    ]);
    expect(events.every((e) => e.title === "Weekly standup")).toBe(true);
    expect(new Set(events.map((e) => e.id)).size).toBe(3); // distinct instance ids
  });

  it("leaves a non-recurring event as a single instance", async () => {
    await provider.createEvent({
      endsAt: new Date("2026-06-01T09:30:00Z"),
      startsAt: new Date("2026-06-01T09:00:00Z"),
      title: "One-off"
    });
    const events = await provider.listEvents({ from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T00:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("One-off");
  });

  it("preserves recurrence across an edit — a renamed weekly event still recurs", async () => {
    const base = await provider.createEvent({
      endsAt: new Date("2026-06-01T09:30:00Z"),
      recurrence: "FREQ=WEEKLY",
      startsAt: new Date("2026-06-01T09:00:00Z"),
      title: "Standup"
    });
    await provider.updateEvent(base.id, { title: "Team standup" });
    const events = await provider.listEvents({ from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-17T00:00:00Z") });
    expect(events).toHaveLength(3); // still recurs after the rename
    expect(events.every((e) => e.title === "Team standup")).toBe(true);
  });

  it("drops a persisted event with an unparseable date instead of silently NaN-filtering it", async () => {
    writeFileSync(join(dir, "calendar.json"), JSON.stringify({
      events: [
        {
          allDay: false,
          endsAt: "2026-05-15T11:00:00Z",
          id: "ok-1",
          startsAt: "2026-05-15T10:00:00Z",
          title: "Valid"
        },
        {
          allDay: false,
          endsAt: "later",
          id: "bad-1",
          startsAt: "tomorrow",
          title: "Corrupt"
        }
      ]
    }));
    const events = await provider.listEvents({ from: new Date(0), to: new Date("2027-01-01T00:00:00Z") });
    // The corrupt event is excluded at load (consistent with
    // CalDAV); the valid one is unaffected and the call doesn't throw.
    expect(events.map((e) => e.id)).toEqual(["ok-1"]);
  });

  it("creates and lists events", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      notes: "weekly sync",
      startsAt: new Date("2026-05-15T10:00:00Z"),
      tags: ["work"],
      title: "Standup"
    });

    expect(created).toMatchObject({ id: "cal_1", providerId: "local", title: "Standup" });

    const events = await provider.listEvents({ from: new Date(0), to: new Date("2026-05-16T00:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "cal_1", title: "Standup", tags: ["work"] });
  });

  it("listEvents sorts by startsAt asc with id asc tiebreaker, independent of file-array insertion order", async () => {
    const sameStart = "2026-05-15T09:00:00.000Z";
    const sameEnd = "2026-05-15T10:00:00.000Z";
    writeFileSync(join(dir, "calendar.json"), JSON.stringify({
      events: [
        { allDay: false, endsAt: sameEnd, id: "cal_b", startsAt: sameStart, title: "1:1" },
        { allDay: false, endsAt: sameEnd, id: "cal_a", startsAt: sameStart, title: "All-hands" },
        { allDay: false, endsAt: sameEnd, id: "cal_c", startsAt: sameStart, title: "Standup" }
      ]
    }));
    const events = await provider.listEvents({ from: new Date(0), to: new Date("2027-01-01T00:00:00Z") });
    expect(
      events.map((e) => e.id),
      "events sharing the same startsAt must come back in id asc order — independent of file-array insertion order"
    ).toEqual(["cal_a", "cal_b", "cal_c"]);
  });

  it("filters events outside the range", async () => {
    await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "In range"
    });
    await provider.createEvent({
      endsAt: new Date("2026-06-15T11:00:00Z"),
      startsAt: new Date("2026-06-15T10:00:00Z"),
      title: "Out of range"
    });

    const events = await provider.listEvents({
      from: new Date("2026-05-14T00:00:00Z"),
      to: new Date("2026-05-16T00:00:00Z")
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("In range");
  });

  it("updates an existing event", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Old title"
    });

    const updated = await provider.updateEvent(created.id, { location: "Room 1", title: "New title" });
    expect(updated).toMatchObject({ location: "Room 1", title: "New title" });
  });

  it("deletes an event", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Doomed"
    });

    await provider.deleteEvent(created.id);
    const events = await provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(events).toEqual([]);
  });

  it("rejects events whose endsAt precedes startsAt", async () => {
    await expect(
      provider.createEvent({
        endsAt: new Date("2026-05-15T09:00:00Z"),
        startsAt: new Date("2026-05-15T10:00:00Z"),
        title: "Reversed"
      })
    ).rejects.toBeInstanceOf(CalendarValidationError);
  });

  it("throws EVENT_NOT_FOUND on missing ids", async () => {
    await expect(provider.deleteEvent("missing")).rejects.toBeInstanceOf(CalendarProviderError);
    await expect(provider.updateEvent("missing", { title: "x" })).rejects.toBeInstanceOf(CalendarProviderError);
  });

  it("updateEvent rejects invalid Date inputs as CalendarValidationError — not the downstream RangeError from .toISOString()", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Movable"
    });

    // Invalid input.endsAt — pre-fix this silently passed the range check
    // (NaN comparisons are false) then crashed downstream in writeAll's
    // .toISOString() with a RangeError that callers couldn't catch as a
    // CalendarValidationError.
    await expect(provider.updateEvent(created.id, { endsAt: new Date("invalid") }))
      .rejects.toBeInstanceOf(CalendarValidationError);
    // Sibling: invalid input.startsAt.
    await expect(provider.updateEvent(created.id, { startsAt: new Date("not-a-date") }))
      .rejects.toBeInstanceOf(CalendarValidationError);

    // Sanity: the create-time validation parity is intact — the same
    // shape on createEvent already rejects the same way.
    await expect(provider.createEvent({
      endsAt: new Date("invalid"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Bad ends"
    })).rejects.toBeInstanceOf(CalendarValidationError);
  });

  it("survives a corrupt file by treating it as empty", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Survives"
    });
    expect(created.id).toBe("cal_1");
    // simulate corruption — the next read should fall through to []
    const file = join(dir, "calendar.json");
    require("node:fs").writeFileSync(file, "not json");
    const events = await provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(events).toEqual([]);
  });

  it("persists the calendar file with mode 0o600 — events carry title / location / notes / attendees that are private user data", async () => {
    // The credential-store sibling in this package already uses
    // 0o600; the events store was the asymmetric outlier with the
    // default umask (typically 0o644 = world-readable on a shared
    // box). Pin the now-fixed posture so a future refactor can't
    // silently un-do the user-only mode.
    const file = join(dir, "calendar.json");
    await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Standup",
      location: "Zoom",
      notes: "Q2 planning"
    });
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode, "local calendar events file must be user-only — title/location/notes are private").toBe(0o600);

    // Subsequent updates must also produce a 0o600 file (the
    // tmp+rename + chmod pair must hold across the update path).
    await provider.createEvent({
      endsAt: new Date("2026-05-16T11:00:00Z"),
      startsAt: new Date("2026-05-16T10:00:00Z"),
      title: "Followup"
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  describe("updateEvent — create/update field-clear symmetry", () => {
    async function createWithExtras(): Promise<{ id: string }> {
      const e = await provider.createEvent({
        endsAt: new Date("2026-05-15T11:00:00Z"),
        startsAt: new Date("2026-05-15T10:00:00Z"),
        title: "Symmetric",
        location: "Room A",
        notes: "kickoff sync",
        tags: ["work", "meeting"]
      });
      return { id: e.id };
    }

    it("update with location:null clears the field (explicit null is the documented clear)", async () => {
      const { id } = await createWithExtras();
      const updated = await provider.updateEvent(id, { location: null });
      expect(updated.location).toBeUndefined();
      // Persisted shape mirrors the in-memory shape (no orphan ""/null in JSON).
      const reread = (await provider.listEvents({
        from: new Date(0),
        to: new Date(Date.now() + 86_400_000)
      }))[0];
      expect(reread?.location).toBeUndefined();
    });

    it("update with location:\"\" also clears the field (matches create's empty-string strip)", async () => {
      const { id } = await createWithExtras();
      const updated = await provider.updateEvent(id, { location: "" });
      expect(updated.location, "empty-string update must clear like createEvent's truthy strip").toBeUndefined();
      // Sanity: createEvent's create-time strip on "" produces an event
      // with `location` ABSENT — update-to-"" must produce the same.
      const fresh = await provider.createEvent({
        endsAt: new Date("2026-05-16T11:00:00Z"),
        startsAt: new Date("2026-05-16T10:00:00Z"),
        title: "Empty location at create",
        location: ""
      });
      expect(fresh.location, "createEvent must strip an empty-string location").toBeUndefined();
    });

    it("update with notes:\"\" clears the field (sibling defect)", async () => {
      const { id } = await createWithExtras();
      const updated = await provider.updateEvent(id, { notes: "" });
      expect(updated.notes).toBeUndefined();
    });

    it("update with tags:[] clears the field (matches create's empty-array strip)", async () => {
      const { id } = await createWithExtras();
      const updated = await provider.updateEvent(id, { tags: [] });
      expect(updated.tags, "empty-array update must clear like createEvent's length-gated strip").toBeUndefined();
      // Sibling: createEvent already strips empty tags — verify.
      const fresh = await provider.createEvent({
        endsAt: new Date("2026-05-17T11:00:00Z"),
        startsAt: new Date("2026-05-17T10:00:00Z"),
        title: "Empty tags at create",
        tags: []
      });
      expect(fresh.tags).toBeUndefined();
    });

    it("update with omitted fields preserves the existing values", async () => {
      const { id } = await createWithExtras();
      const updated = await provider.updateEvent(id, { title: "Retitled" });
      expect(updated.title).toBe("Retitled");
      expect(updated.location).toBe("Room A");
      expect(updated.notes).toBe("kickoff sync");
      expect(updated.tags).toEqual(["work", "meeting"]);
    });

    it("update with whitespace-only location:\"   \" passes through unchanged (matches create's truthy-only strip)", async () => {
      const { id } = await createWithExtras();
      const updated = await provider.updateEvent(id, { location: "   " });
      expect(updated.location, "whitespace-only is preserved on both create and update sides").toBe("   ");
    });
  });
});

describe("CalendarProviderRegistry", () => {
  it("requires explicit provider id for mutations and falls back to primary on omission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cal-reg-"));
    const provider = new LocalCalendarProvider({ file: join(dir, "cal.json") });
    const registry = new CalendarProviderRegistry([provider]);

    expect(registry.has("local")).toBe(true);
    expect(registry.describe()).toHaveLength(1);

    const created = await registry.createEvent(undefined, {
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Primary route"
    });
    expect(created.providerId).toBe("local");

    expect(() => registry.require("ghost")).toThrowError(CalendarProviderError);

    rmSync(dir, { force: true, recursive: true });
  });

  it("the unknown-id error names the registered providers so a misconfigured calendar id is recoverable", () => {
    const empty = new CalendarProviderRegistry();
    expect(() => empty.require("local")).toThrow(/none registered/u);

    const dir = mkdtempSync(join(tmpdir(), "muse-cal-hint-"));
    const provider = new LocalCalendarProvider({ file: join(dir, "cal.json") });
    const registry = new CalendarProviderRegistry([provider]);
    expect(() => registry.require("locale")).toThrow(/registered: local/u);
    rmSync(dir, { force: true, recursive: true });
  });

  it("listEventsWithDiagnostics applies a deterministic tiebreaker (providerId, then event id) so simultaneous events don't shuffle across runs", async () => {
    // Pre-fix the sort was `startsAt.getTime()` only — two events
    // at the same minute (recurring meetings, two providers both
    // returning the same calendar slot, a back-to-back schedule)
    // shuffled per Promise.all completion order. A user reading
    // `muse calendar today` saw different ordering across runs and
    // any UI snapshot test that pinned a screen-shot was flaky.
    const shared = new Date("2026-05-15T10:00:00.000Z");
    const ends = new Date("2026-05-15T11:00:00.000Z");
    const fixedShape = (id: string, providerId: string, title: string): CalendarEvent => ({
      allDay: false,
      endsAt: ends,
      id,
      providerId,
      startsAt: shared,
      title
    });
    function fakeProvider(providerId: string, events: readonly CalendarEvent[]): CalendarProvider {
      return {
        createEvent: async () => { throw new Error("not used"); },
        deleteEvent: async () => { throw new Error("not used"); },
        describe: () => ({
          credentials: [],
          description: "test",
          displayName: providerId,
          id: providerId,
          local: true
        }),
        id: providerId,
        listEvents: async () => events,
        updateEvent: async () => { throw new Error("not used"); }
      };
    }
    // Register zeta BEFORE alpha so the Promise.all fan-out doesn't
    // accidentally produce alphabetical order by coincidence.
    const registry = new CalendarProviderRegistry([
      fakeProvider("zeta", [
        fixedShape("z2", "zeta", "Zeta later id"),
        fixedShape("z1", "zeta", "Zeta earlier id")
      ]),
      fakeProvider("alpha", [
        fixedShape("a1", "alpha", "Alpha single")
      ])
    ]);

    const detailed = await registry.listEventsWithDiagnostics({
      from: new Date(0),
      to: new Date("2026-06-01T00:00:00Z")
    });
    // Tiebreaker order: same startsAt → providerId asc → event id asc.
    // Expected: alpha/a1, zeta/z1, zeta/z2 — pinned regardless of
    // registration order or Promise.all completion order.
    expect(detailed.events.map((event) => `${event.providerId}/${event.id}`)).toEqual([
      "alpha/a1",
      "zeta/z1",
      "zeta/z2"
    ]);
  });

  it("falls back to surviving providers when one throws; diagnostics name the failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cal-fallback-"));
    const local = new LocalCalendarProvider({ file: join(dir, "cal.json") });
    await local.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "From local"
    });

    // Stub a flaky remote provider that always throws.
    const flakyRemote = {
      id: "gcal",
      describe: () => ({ id: "gcal", name: "Google", capabilities: { write: true } as never }),
      listEvents: async () => {
        throw new Error("gcal upstream 503");
      },
      createEvent: async () => { throw new Error("not used"); },
      updateEvent: async () => { throw new Error("not used"); },
      deleteEvent: async () => { throw new Error("not used"); }
    };

    const errorLog: { id: string; msg: string }[] = [];
    const registry = new CalendarProviderRegistry([local, flakyRemote as never], {
      onProviderError: (id, msg) => errorLog.push({ id, msg })
    });

    // Plain listEvents returns the local provider's events (other
    // providers swallowed); the diagnostics path names the failed
    // provider explicitly.
    const events = await registry.listEvents({ from: new Date(0), to: new Date("2026-05-16T00:00:00Z") });
    expect(events.length).toBe(1);
    expect(events[0]?.title).toBe("From local");

    const detailed = await registry.listEventsWithDiagnostics({
      from: new Date(0),
      to: new Date("2026-05-16T00:00:00Z")
    });
    expect(detailed.events.length).toBe(1);
    expect(detailed.failedProviders).toEqual([
      { providerId: "gcal", message: "gcal upstream 503" }
    ]);
    // onProviderError fires once per failed provider per call —
    // both listEvents() and listEventsWithDiagnostics() hit gcal,
    // so the log has two entries (one per fan-out).
    expect(errorLog).toEqual([
      { id: "gcal", msg: "gcal upstream 503" },
      { id: "gcal", msg: "gcal upstream 503" }
    ]);

    rmSync(dir, { force: true, recursive: true });
  });
});

describe("FileCalendarCredentialStore", () => {
  it("persists, reads, and removes provider credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const store = new FileCalendarCredentialStore(join(dir, "credentials.json"));

    expect(await store.list()).toEqual([]);
    expect(await store.load("gcal")).toBeUndefined();

    await store.save("gcal", { clientId: "abc", refreshToken: "tok" });
    expect(await store.load("gcal")).toEqual({ clientId: "abc", refreshToken: "tok" });
    expect(await store.list()).toEqual(["gcal"]);

    await store.remove("gcal");
    expect(await store.load("gcal")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    rmSync(dir, { force: true, recursive: true });
  });

  it("provider ids colliding with Object.prototype don't false-load or pollute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-proto-"));
    const file = join(dir, "credentials.json");
    const store = new FileCalendarCredentialStore(file);

    // Fresh store (no file): a prototype-named id must be absent,
    // not a bogus truthy {} from Object.prototype.toString.
    for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(await store.load(id)).toBeUndefined();
      await store.remove(id); // must be a no-op, not throw / mass-rewrite
    }

    await store.save("google", { clientId: "x", refreshToken: "y" });
    expect(await store.load("google")).toEqual({ clientId: "x", refreshToken: "y" });
    expect(await store.load("toString")).toBeUndefined();

    // A hand-edited file with a __proto__ key is contained.
    writeFileSync(file, `{"version":1,"providers":{"__proto__":{"clientId":"PWNED"},"ok":{"clientId":"fine"}}}`);
    expect(await store.load("ok")).toEqual({ clientId: "fine" });
    expect(({} as Record<string, unknown>).clientId).toBeUndefined();
    expect(await store.list()).toContain("ok");

    rmSync(dir, { force: true, recursive: true });
  });
});

describe("isRetryableCalendarStatus", () => {
  it("classifies 429 + 5xx as retryable, everything else as fail-fast", () => {
    expect(isRetryableCalendarStatus(429)).toBe(true);
    expect(isRetryableCalendarStatus(500)).toBe(true);
    expect(isRetryableCalendarStatus(503)).toBe(true);
    expect(isRetryableCalendarStatus(599)).toBe(true);
    for (const s of [400, 401, 403, 404, 412, 422]) {
      expect(isRetryableCalendarStatus(s)).toBe(false);
    }
    expect(isRetryableCalendarStatus(200)).toBe(false);
    expect(isRetryableCalendarStatus(600)).toBe(false);
    expect(isRetryableCalendarStatus(Number.NaN)).toBe(false);
    expect(isRetryableCalendarStatus(undefined)).toBe(false);
  });

  it("CalendarProviderError carries retryable derived from status", () => {
    expect(new CalendarProviderError("gcal", "HTTP_429", "rate-limited", undefined, 429).retryable).toBe(true);
    expect(new CalendarProviderError("gcal", "HTTP_503", "down", undefined, 503).retryable).toBe(true);
    expect(new CalendarProviderError("gcal", "HTTP_401", "bad token", undefined, 401).retryable).toBe(false);
    // Legacy call sites that don't pass status — local / validation
    // errors aren't transient.
    expect(new CalendarProviderError("local", "EVENT_NOT_FOUND", "missing").retryable).toBe(false);
  });
});

describe("CalendarProviderRegistry.createEvent — model-fabricated providerId sentinel", () => {
  let dir: string;
  let registry: CalendarProviderRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-cal-reg-"));
    registry = new CalendarProviderRegistry([
      new LocalCalendarProvider({ file: join(dir, "calendar.json"), idFactory: counter() })
    ]);
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  const input = { allDay: false, endsAt: new Date("2026-06-01T16:00:00Z"), startsAt: new Date("2026-06-01T15:00:00Z"), title: "Meeting with Sam" };

  it("routes a fabricated 'default' providerId to the primary provider instead of throwing", async () => {
    const created = await registry.createEvent("default", input);
    expect(created.title).toBe("Meeting with Sam");
  });

  it("also accepts 'primary' and whitespace as the sentinel", async () => {
    await expect(registry.createEvent("primary", input)).resolves.toBeDefined();
    await expect(registry.createEvent("  ", input)).resolves.toBeDefined();
  });

  it("still errors on a concrete unknown id rather than silently misrouting", () => {
    expect(() => registry.createEvent("google", input)).toThrow(/not registered/);
  });

  it("still targets a real registered id exactly", async () => {
    const created = await registry.createEvent("local", input);
    expect(created.title).toBe("Meeting with Sam");
  });
});

function counter(): () => string {
  let i = 0;
  return () => `cal_${++i}`;
}
