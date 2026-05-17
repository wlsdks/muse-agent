import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  LocalCalendarProvider,
  MacOsCalendarProvider,
  isRetryableCalendarStatus
} from "../src/index.js";

describe("MacOsCalendarProvider osascript spawn timeout", () => {
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

  it("falls back to surviving providers when one throws; diagnostics name the failure (goal 071)", async () => {
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

describe("isRetryableCalendarStatus (goal 135)", () => {
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

function counter(): () => string {
  let i = 0;
  return () => `cal_${++i}`;
}
