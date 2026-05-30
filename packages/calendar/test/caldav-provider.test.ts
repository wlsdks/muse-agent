import { describe, expect, it } from "vitest";

import { CalDAVCalendarProvider } from "../src/caldav-provider.js";
import type { CalendarRange } from "../src/types.js";

// Direct coverage for the CalDAV provider (untested module) — a daily-reliability
// actuator. Driven through the injected fetchImpl with a CONTRACT-FAITHFUL HTTP
// fake (real CalDAV multistatus XML / ICS, real method+header+body assertions),
// never a stubbed registry. Covers the reliability contract (retry the
// idempotent REPORT read on transient failure; NEVER retry a write; fail-close
// on a hard error) and the ICS parse robustness (folded lines, VTIMEZONE-before-
// VEVENT, TZID→UTC, all-day).

interface Call { url: string; method?: string; headers: Record<string, string>; body?: string }

const recordingFetch = (responder: (attempt: number) => Response): { impl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ body: init.body as string | undefined, headers: init.headers as Record<string, string>, method: init.method, url });
    return responder(calls.length);
  }) as unknown as typeof fetch;
  return { calls, impl };
};

const multistatus = (ics: string): string =>
  `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/cal/x.ics</D:href>` +
  `<D:propstat><D:prop><C:calendar-data>${ics.replace(/</gu, "&lt;")}</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>`;

const vevent = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:ev1", "SUMMARY:Standup",
  "DTSTART:20260530T090000Z", "DTEND:20260530T093000Z", "LOCATION:Room A", "END:VEVENT", "END:VCALENDAR"
].join("\r\n");

const RANGE: CalendarRange = { from: new Date("2026-05-30T00:00:00Z"), to: new Date("2026-05-31T00:00:00Z") };
const ok = (body: string): Response => new Response(body, { status: 200 });

describe("CalDAVCalendarProvider — listEvents (REPORT)", () => {
  it("issues a REPORT with Depth:1, basic auth, and a time-range filter, then parses the multistatus into events", async () => {
    const fetch = recordingFetch(() => ok(multistatus(vevent)));
    const provider = new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://dav.test/cal", username: "u" });
    const events = await provider.listEvents(RANGE);

    expect(events).toEqual([{
      allDay: false,
      endsAt: new Date("2026-05-30T09:30:00Z"),
      id: "ev1",
      location: "Room A",
      providerId: "caldav",
      startsAt: new Date("2026-05-30T09:00:00Z"),
      title: "Standup"
    }]);
    const call = fetch.calls[0]!;
    expect(call.method).toBe("REPORT");
    expect(call.headers.depth).toBe("1");
    expect(call.headers.authorization).toMatch(/^Basic /u);
    expect(call.url).toBe("https://dav.test/cal/"); // trailing slash normalized
    expect(call.body).toContain('time-range start="20260530T000000Z" end="20260531T000000Z"');
  });

  it("RETRIES a transient 503 on the idempotent read, then succeeds", async () => {
    const fetch = recordingFetch((attempt) => (attempt < 2 ? new Response("busy", { status: 503 }) : ok(multistatus(vevent))));
    const provider = new CalDAVCalendarProvider({
      fetchImpl: fetch.impl, password: "p", retry: { baseDelayMs: 1, retries: 2, sleep: async () => {} }, url: "https://dav.test/cal/", username: "u"
    });
    expect(await provider.listEvents(RANGE)).toHaveLength(1);
    expect(fetch.calls).toHaveLength(2); // one retry
  });

  it("does NOT retry a non-retryable 403 and throws HTTP_403 carrying the status", async () => {
    const fetch = recordingFetch(() => new Response("denied", { status: 403 }));
    const provider = new CalDAVCalendarProvider({
      fetchImpl: fetch.impl, password: "p", retry: { retries: 2, sleep: async () => {} }, url: "https://dav.test/cal/", username: "u"
    });
    await expect(provider.listEvents(RANGE)).rejects.toMatchObject({ code: "HTTP_403", status: 403 });
    expect(fetch.calls).toHaveLength(1); // no retry on a 4xx
  });
});

describe("CalDAVCalendarProvider — ICS parse robustness", () => {
  const fetchOf = (ics: string) => recordingFetch(() => ok(multistatus(ics)));
  const wide: CalendarRange = { from: new Date(0), to: new Date("2027-01-01T00:00:00Z") };

  it("parses an all-day VALUE=DATE event to midnight UTC", async () => {
    const ics = ["BEGIN:VEVENT", "UID:ad1", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226", "END:VEVENT"].join("\r\n");
    const f = fetchOf(ics);
    const [event] = await new CalDAVCalendarProvider({ fetchImpl: f.impl, password: "p", url: "https://d/c/", username: "u" }).listEvents(wide);
    expect(event).toMatchObject({ allDay: true, startsAt: new Date("2026-12-25T00:00:00Z"), title: "Holiday" });
  });

  it("uses the VEVENT DTSTART even when a VTIMEZONE block precedes it, converting TZID to UTC", async () => {
    const ics = [
      "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:20071104T020000", "END:STANDARD", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:tz1", "SUMMARY:Meeting", "DTSTART;TZID=America/New_York:20260615T090000", "DTEND;TZID=America/New_York:20260615T100000", "END:VEVENT"
    ].join("\r\n");
    const f = fetchOf(ics);
    const [event] = await new CalDAVCalendarProvider({ fetchImpl: f.impl, password: "p", url: "https://d/c/", username: "u" }).listEvents(wide);
    expect(event?.startsAt.toISOString()).toBe("2026-06-15T13:00:00.000Z"); // 09:00 EDT → 13:00 UTC, not the DST-rule date
    expect(event?.title).toBe("Meeting");
  });

  it("unfolds a folded (CRLF+space) content line and defaults endsAt to startsAt when DTEND is absent", async () => {
    const ics = ["BEGIN:VEVENT", "UID:f1", "SUMMARY:Quarterly planning meeting with the \r\n entire product team", "DTSTART:20260601T090000Z", "END:VEVENT"].join("\r\n");
    const f = fetchOf(ics);
    const [event] = await new CalDAVCalendarProvider({ fetchImpl: f.impl, password: "p", url: "https://d/c/", username: "u" }).listEvents(wide);
    expect(event?.title).toBe("Quarterly planning meeting with the entire product team");
    expect(event?.endsAt.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });
});

describe("CalDAVCalendarProvider — writes (PUT / DELETE)", () => {
  it("createEvent PUTs a VEVENT to <url>/<uid>.ics and returns the event with the generated id", async () => {
    const fetch = recordingFetch(() => new Response("", { status: 201 }));
    const provider = new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    const created = await provider.createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), startsAt: new Date("2026-06-01T10:00:00Z"), title: "New" });

    expect(fetch.calls[0]?.method).toBe("PUT");
    expect(fetch.calls[0]?.url.endsWith(".ics")).toBe(true);
    expect(fetch.calls[0]?.body).toContain("BEGIN:VEVENT");
    expect(created.id.startsWith("cal_")).toBe(true);
    expect(created.providerId).toBe("caldav");
  });

  it("createEvent throws on a non-ok status (a write is never silently dropped)", async () => {
    const fetch = recordingFetch(() => new Response("server error", { status: 500 }));
    const provider = new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(provider.createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" })).rejects.toMatchObject({ code: "HTTP_500" });
  });

  it("deleteEvent tolerates a 404 (already gone) but throws on other errors", async () => {
    const okDelete = recordingFetch(() => new Response("", { status: 404 }));
    const p1 = new CalDAVCalendarProvider({ fetchImpl: okDelete.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(p1.deleteEvent("ev1")).resolves.toBeUndefined();
    expect(okDelete.calls[0]?.method).toBe("DELETE");

    const badDelete = recordingFetch(() => new Response("err", { status: 500 }));
    const p2 = new CalDAVCalendarProvider({ fetchImpl: badDelete.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(p2.deleteEvent("ev1")).rejects.toMatchObject({ code: "HTTP_500" });
  });

  it("updateEvent throws EVENT_NOT_FOUND when the id is absent from the listed events", async () => {
    const fetch = recordingFetch(() => ok(multistatus(vevent))); // only ev1 exists
    const provider = new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(provider.updateEvent("missing", { title: "x" })).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});
