import { describe, expect, it } from "vitest";

import { CalDAVCalendarProvider } from "../src/caldav-provider.js";
import type { CalendarRange } from "../src/types.js";

// Direct coverage for the CalDAV provider (untested module) — a daily-reliability
// actuator. Driven through the injected fetchImpl with a CONTRACT-FAITHFUL HTTP
// fake (real CalDAV multistatus XML / ICS, real method+header+body assertions),
// never a stubbed registry. Covers the reliability contract (retry the
// idempotent REPORT read on transient failure; retry a write ONLY on a 429
// rate-limit — never an ambiguous 5xx — honouring Retry-After; fail-close
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
  it("resolves an exact id+start with one read-only REPORT", async () => {
    const fetch = recordingFetch(() => ok(multistatus(vevent)));
    const provider = new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(provider.resolveExactEvent({ eventId: "ev1", startsAt: "2026-05-30T09:00:00.000Z" }))
      .resolves.toMatchObject({ id: "ev1", title: "Standup" });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.method).toBe("REPORT");
  });

  it("reconstructs a recurring occurrence stably across windows and provider restarts", async () => {
    const recurring = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:daily", "SUMMARY:Daily sync",
      "DTSTART:20260528T090000Z", "DTEND:20260528T093000Z", "RRULE:FREQ=DAILY;COUNT=4",
      "END:VEVENT", "END:VCALENDAR"
    ].join("\r\n");
    const make = () => new CalDAVCalendarProvider({ fetchImpl: recordingFetch(() => ok(multistatus(recurring))).impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    const first = make();
    const may29 = await first.listEvents({ from: new Date("2026-05-29T09:00:00Z"), to: new Date("2026-05-29T09:00:00Z") });
    const may30 = await first.listEvents({ from: new Date("2026-05-30T09:00:00Z"), to: new Date("2026-05-30T09:00:00Z") });
    expect(may29[0]).toMatchObject({ id: "daily-1", providerEventId: "daily" });
    expect(may30[0]).toMatchObject({ id: "daily-2", providerEventId: "daily" });
    await expect(make().resolveExactEvent({ eventId: "daily", startsAt: "2026-05-30T09:00:00.000Z" }))
      .resolves.toMatchObject({ id: "daily-2", providerEventId: "daily", title: "Daily sync" });
  });

  it("bounds a hung REPORT with an abort signal", async () => {
    const hung = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const provider = new CalDAVCalendarProvider({ fetchImpl: hung, password: "p", retry: { retries: 0 }, timeoutMs: 25, url: "https://dav.test/cal/", username: "u" });
    const started = Date.now();
    await expect(provider.resolveExactEvent({ eventId: "ev1", startsAt: "2026-05-30T09:00:00.000Z" }))
      .rejects.toMatchObject({ code: "REPORT_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("distinguishes malformed exact data from a genuinely absent event", async () => {
    const malformed = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:bad", "DTSTART:not-a-date", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const bad = new CalDAVCalendarProvider({ fetchImpl: recordingFetch(() => ok(multistatus(malformed))).impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(bad.resolveExactEvent({ eventId: "bad", startsAt: "2026-05-30T09:00:00.000Z" }))
      .rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });

    const empty = new CalDAVCalendarProvider({ fetchImpl: recordingFetch(() => ok('<D:multistatus xmlns:D="DAV:"/>')).impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await expect(empty.resolveExactEvent({ eventId: "missing", startsAt: "2026-05-30T09:00:00.000Z" })).resolves.toBeUndefined();
  });
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

  it("caps an excessive configured retry delay before scheduling the next REPORT", async () => {
    const slept: number[] = [];
    const fetch = recordingFetch((attempt) => (attempt < 2 ? new Response("busy", { status: 503 }) : ok(multistatus(vevent))));
    const provider = new CalDAVCalendarProvider({
      fetchImpl: fetch.impl,
      password: "p",
      retry: { baseDelayMs: Number.MAX_VALUE, retries: 1, sleep: async (ms) => { slept.push(ms); } },
      url: "https://dav.test/cal/",
      username: "u"
    });

    await expect(provider.listEvents(RANGE)).resolves.toHaveLength(1);
    expect(slept).toEqual([30_000]);
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

describe("CalDAVCalendarProvider — RFC5545 text escaping round-trip", () => {
  const wide: CalendarRange = { from: new Date(0), to: new Date("2027-01-01T00:00:00Z") };

  it("unescapes \\, \\; \\n \\\\ in SUMMARY/LOCATION and maps DESCRIPTION to notes", async () => {
    const ics = [
      "BEGIN:VEVENT", "UID:esc1",
      "SUMMARY:A\\, B\\; C\\nD\\\\E", // A, B; C<newline>D\E
      "LOCATION:Rm\\, 5",
      "DESCRIPTION:line1\\nline2",
      "DTSTART:20260601T090000Z", "DTEND:20260601T093000Z", "END:VEVENT"
    ].join("\r\n");
    const fetch = recordingFetch(() => ok(multistatus(ics)));
    const [event] = await new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://d/c/", username: "u" }).listEvents(wide);
    expect(event?.title).toBe("A, B; C\nD\\E");
    expect(event?.location).toBe("Rm, 5");
    expect(event?.notes).toBe("line1\nline2");
  });

  it("escapes , ; and newline when rendering SUMMARY/DESCRIPTION on write (no ICS property injection)", async () => {
    const fetch = recordingFetch(() => new Response("", { status: 201 }));
    const provider = new CalDAVCalendarProvider({ fetchImpl: fetch.impl, password: "p", url: "https://dav.test/cal/", username: "u" });
    await provider.createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), notes: "a\nb", startsAt: new Date("2026-06-01T10:00:00Z"), title: "Sync, plan; review" });
    const lines = (fetch.calls[0]!.body as string).split("\r\n");
    expect(lines).toContain("SUMMARY:Sync\\, plan\\; review");
    expect(lines).toContain("DESCRIPTION:a\\nb");
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

describe("CalDAVCalendarProvider — writes retry only a 429 rate-limit (Retry-After parity with the Google adapter)", () => {
  const created = (): Response => new Response("", { status: 201 });
  const writer = (responder: (attempt: number) => Response, slept: number[]) => {
    const fetch = recordingFetch(responder);
    const provider = new CalDAVCalendarProvider({
      fetchImpl: fetch.impl, password: "p", retry: { retries: 2, sleep: async (ms: number) => { slept.push(ms); } }, url: "https://dav.test/cal/", username: "u"
    });
    return { fetch, provider };
  };

  it("RETRIES a 429 PUT, then succeeds — safe because a 429 is rejected BEFORE the mutation applies (honours Retry-After)", async () => {
    const slept: number[] = [];
    const { fetch, provider } = writer((attempt) => (attempt < 2 ? new Response("rate", { headers: { "retry-after": "2" }, status: 429 }) : created()), slept);
    const event = await provider.createEvent({ endsAt: new Date("2026-06-01T11:00:00Z"), startsAt: new Date("2026-06-01T10:00:00Z"), title: "New" });
    expect(event.title).toBe("New");
    expect(fetch.calls).toHaveLength(2); // one 429 + one success
    expect(fetch.calls.every((c) => c.method === "PUT")).toBe(true);
    expect(slept).toEqual([2000]); // honoured Retry-After (2s), not the 250ms backoff
  });

  it("does NOT retry a 5xx PUT (a retried CalDAV write could double-create)", async () => {
    const slept: number[] = [];
    const { fetch, provider } = writer(() => new Response("server error", { status: 503 }), slept);
    await expect(provider.createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" })).rejects.toMatchObject({ code: "HTTP_503" });
    expect(fetch.calls).toHaveLength(1); // no retry on an ambiguous write 5xx
    expect(slept).toEqual([]);
  });

  it("a 429 with no Retry-After falls back to exponential backoff", async () => {
    const slept: number[] = [];
    const { provider } = writer((attempt) => (attempt < 2 ? new Response("rate", { status: 429 }) : created()), slept);
    await provider.createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" });
    expect(slept).toEqual([250]); // baseDelayMs * 2^0, no server hint
  });

  it("exhausts the 429 retry budget and surfaces HTTP_429 (no infinite loop)", async () => {
    const slept: number[] = [];
    const { fetch, provider } = writer(() => new Response("rate", { headers: { "retry-after": "1" }, status: 429 }), slept);
    await expect(provider.createEvent({ endsAt: new Date(1), startsAt: new Date(0), title: "x" })).rejects.toMatchObject({ code: "HTTP_429" });
    expect(fetch.calls).toHaveLength(3); // initial + 2 retries, then give up
  });

  it("a 429 DELETE is retried too, then tolerates the eventual 204", async () => {
    const slept: number[] = [];
    const { fetch, provider } = writer((attempt) => (attempt < 2 ? new Response("rate", { headers: { "retry-after": "1" }, status: 429 }) : new Response(null, { status: 204 })), slept);
    await expect(provider.deleteEvent("ev1")).resolves.toBeUndefined();
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls.every((c) => c.method === "DELETE")).toBe(true);
  });
});
