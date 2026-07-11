import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CalDAVCalendarProvider,
  GoogleCalendarProvider,
  MacOsCalendarProvider
} from "../src/index.js";

interface Captured {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  body: string;
}

function record(calls: Captured[], url: string, init?: RequestInit): void {
  const headers = new Headers(init?.headers);
  calls.push({
    authorization: headers.get("authorization") ?? undefined,
    body: typeof init?.body === "string" ? init.body : "",
    contentType: headers.get("content-type") ?? undefined,
    method: (init?.method ?? "GET").toUpperCase(),
    url
  });
}

const START = new Date("2026-06-01T09:00:00.000Z");
const END = new Date("2026-06-01T10:00:00.000Z");

describe("GoogleCalendarProvider WRITE — contract-faithful HTTP fake (not read-only)", () => {
  function provider(calls: Captured[]) {
    return new GoogleCalendarProvider({
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
        }
        record(calls, u, init);
        if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return new Response(
          JSON.stringify({
            end: { dateTime: END.toISOString() },
            id: "g-1",
            start: { dateTime: START.toISOString() },
            summary: "Q3 review"
          }),
          { status: 200 }
        );
      }) as unknown as typeof fetch,
      refreshToken: "rtok"
    });
  }

  it("createEvent POSTs the real Google Calendar API request with a Bearer token and JSON body", async () => {
    const calls: Captured[] = [];
    const created = await provider(calls).createEvent({ endsAt: END, startsAt: START, title: "Q3 review" });
    expect(created.id).toBe("g-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(calls[0]!.authorization).toBe("Bearer tok-1");
    const body = JSON.parse(calls[0]!.body) as { summary: string; start: { dateTime: string } };
    expect(body.summary).toBe("Q3 review");
    expect(body.start.dateTime).toBe(START.toISOString());
  });

  it("updateEvent (move) PATCHes the event resource", async () => {
    const calls: Captured[] = [];
    await provider(calls).updateEvent("g-1", { startsAt: new Date("2026-06-02T09:00:00.000Z") });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/g-1");
    const body = JSON.parse(calls[0]!.body) as { start: { dateTime: string } };
    expect(body.start.dateTime).toBe("2026-06-02T09:00:00.000Z");
  });

  it("deleteEvent (cancel) DELETEs the event resource", async () => {
    const calls: Captured[] = [];
    await provider(calls).deleteEvent("g-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/g-1");
    expect(calls[0]!.authorization).toBe("Bearer tok-1");
  });
});

describe("CalDAVCalendarProvider WRITE — contract-faithful HTTP fake (not read-only)", () => {
  function multistatus(uid: string): string {
    const ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", `UID:${uid}`, "SUMMARY:Old title",
      "DTSTART:20260601T090000Z", "DTEND:20260601T100000Z", "END:VEVENT", "END:VCALENDAR"
    ].join("\n");
    return (
      `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<D:response><D:href>/dav/${uid}.ics</D:href><D:propstat><D:prop>` +
      `<C:calendar-data>${ics}</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>`
    );
  }

  function provider(calls: Captured[]) {
    return new CalDAVCalendarProvider({
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "REPORT") {
          return new Response(multistatus("upd-1"), { status: 200 });
        }
        record(calls, String(url), init);
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
      password: "pw",
      url: "https://cal.test/dav/",
      username: "user"
    });
  }

  it("createEvent PUTs an ICS VEVENT with Basic auth and a calendar content-type", async () => {
    const calls: Captured[] = [];
    const created = await provider(calls).createEvent({ endsAt: END, startsAt: START, title: "Budget sync" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://cal.test/dav/${created.id}.ics`);
    expect(calls[0]!.authorization).toMatch(/^Basic /u);
    expect(calls[0]!.contentType).toContain("text/calendar");
    expect(calls[0]!.body).toContain("BEGIN:VEVENT");
    expect(calls[0]!.body).toContain("SUMMARY:Budget sync");
  });

  it("updateEvent (move) re-PUTs the same .ics resource with the merged VEVENT", async () => {
    const calls: Captured[] = [];
    await provider(calls).updateEvent("upd-1", { title: "Renamed sync" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://cal.test/dav/upd-1.ics");
    expect(calls[0]!.body).toContain("SUMMARY:Renamed sync");
  });

  it("deleteEvent (cancel) DELETEs the .ics resource", async () => {
    const calls: Captured[] = [];
    await provider(calls).deleteEvent("del-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://cal.test/dav/del-1.ics");
    expect(calls[0]!.authorization).toMatch(/^Basic /u);
  });
});

describe.skipIf(process.platform === "win32")("MacOsCalendarProvider WRITE — contract-faithful osascript fake (not read-only)", () => {
  function fakeOsascript(captureFile: string): string {
    const dir = mkdtempSync(join(tmpdir(), "muse-osa-write-"));
    const script = join(dir, "fake-osascript");
    writeFileSync(
      script,
      `#!${process.execPath}\n` +
        `let s="";process.stdin.on("data",c=>s+=c);` +
        `process.stdin.on("end",()=>{require("node:fs").writeFileSync(${JSON.stringify(captureFile)},s);process.stdout.write("uid-mac-1\\n");process.exit(0);});\n`
    );
    chmodSync(script, 0o755);
    return script;
  }

  it("createEvent emits a 'make new event' AppleScript with the summary, over the real osascript transport", async () => {
    const capture = join(mkdtempSync(join(tmpdir(), "muse-osa-cap-")), "script.applescript");
    const provider = new MacOsCalendarProvider({ osascriptPath: fakeOsascript(capture), timeoutMs: 10_000 });
    const created = await provider.createEvent({ endsAt: END, startsAt: START, title: "Standup" });
    expect(created.id).toBe("uid-mac-1");
    const applescript = readFileSync(capture, "utf8");
    expect(applescript).toContain("make new event");
    expect(applescript).toContain('summary: "Standup"');
  });

  it("deleteEvent (cancel) emits a 'delete' AppleScript scoped to the event uid", async () => {
    const capture = join(mkdtempSync(join(tmpdir(), "muse-osa-cap-")), "script.applescript");
    const provider = new MacOsCalendarProvider({ osascriptPath: fakeOsascript(capture), timeoutMs: 10_000 });
    await provider.deleteEvent("del-mac");
    const applescript = readFileSync(capture, "utf8");
    expect(applescript).toContain("delete");
    expect(applescript).toContain('whose uid is "del-mac"');
  });
});
