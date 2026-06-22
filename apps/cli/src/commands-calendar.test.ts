import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalCalendarProvider } from "@muse/calendar";
import { type PersistedReminder } from "@muse/stores";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eventsToAvailability,
  formatAvailability,
  buildEventReminder,
  conflictWarningForNewEvent,
  formatConflicts,
  removeRemindersForEvent,
  rescheduleRemindersForEvent,
  maxOfNumbers,
  minOfNumbers,
  parseEventStart,
  recurrenceRuleFor,
  registerCalendarCommands,
  resolveEventIdMatch,
  type CalendarCommandHelpers
} from "./commands-calendar.js";

describe("recurrenceRuleFor — map a --repeat cadence to an RRULE", () => {
  it("maps the supported daily/weekly cadences (case-insensitive)", () => {
    expect(recurrenceRuleFor("daily")).toBe("FREQ=DAILY");
    expect(recurrenceRuleFor("WEEKLY")).toBe("FREQ=WEEKLY");
    expect(recurrenceRuleFor("  weekly ")).toBe("FREQ=WEEKLY");
    expect(recurrenceRuleFor("monthly")).toBe("FREQ=MONTHLY");
    expect(recurrenceRuleFor("YEARLY")).toBe("FREQ=YEARLY");
  });
  it("returns undefined for an unsupported cadence (so the command rejects it)", () => {
    expect(recurrenceRuleFor("hourly")).toBeUndefined();
    expect(recurrenceRuleFor("biweekly")).toBeUndefined();
    expect(recurrenceRuleFor("")).toBeUndefined();
  });
});

describe("conflictWarningForNewEvent — heads-up when a new event double-books", () => {
  const ev = (title: string, startIso: string, endIso: string) => ({ title, startsAt: new Date(startIso), endsAt: new Date(endIso) });
  const lunch = ev("Lunch with Dana", "2026-06-10T12:00:00", "2026-06-10T13:00:00");

  it("warns, naming the clashing event(s) with their times, when the new event overlaps", () => {
    const out = conflictWarningForNewEvent(lunch, [ev("Standup", "2026-06-10T12:30:00", "2026-06-10T13:30:00")]);
    expect(out).toContain("⚠ Heads up");
    expect(out).toContain("\"Standup\"");
    expect(out).toContain("(Added anyway.)");
  });

  it("is EMPTY when nothing overlaps, and for a BACK-TO-BACK (touching) event", () => {
    expect(conflictWarningForNewEvent(lunch, [ev("Earlier", "2026-06-10T09:00:00", "2026-06-10T10:00:00")])).toBe("");
    // back-to-back: ends exactly when lunch starts → NOT a conflict
    expect(conflictWarningForNewEvent(lunch, [ev("Just before", "2026-06-10T11:00:00", "2026-06-10T12:00:00")])).toBe("");
  });

  it("lists multiple overlapping events", () => {
    const out = conflictWarningForNewEvent(lunch, [
      ev("Call", "2026-06-10T12:15:00", "2026-06-10T12:45:00"),
      ev("Review", "2026-06-10T12:50:00", "2026-06-10T13:20:00")
    ]);
    expect(out).toContain("\"Call\"");
    expect(out).toContain("\"Review\"");
  });

  it("does NOT flag an all-day event as a double-booking (it's a backdrop, not a booking)", () => {
    const holiday = { allDay: true, title: "Holiday", startsAt: new Date("2026-06-10T00:00:00"), endsAt: new Date("2026-06-11T00:00:00") };
    expect(conflictWarningForNewEvent(lunch, [holiday])).toBe("");
    // a timed event still clashes with another timed event the same day
    expect(conflictWarningForNewEvent(lunch, [holiday, ev("Standup", "2026-06-10T12:30:00", "2026-06-10T13:30:00")])).toContain("\"Standup\"");
  });
});

describe("buildEventReminder — the 'remind me N min before' reminder for muse calendar add", () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const start = new Date("2026-07-01T14:00:00.000Z");

  it("is due exactly N minutes before the event, pending, with a readable text", () => {
    const r = buildEventReminder("Dentist", start, 30, now, "rem_x");
    expect(r).toEqual({
      createdAt: "2026-06-01T00:00:00.000Z",
      dueAt: "2026-07-01T13:30:00.000Z",
      id: "rem_x",
      status: "pending",
      text: "Dentist — in 30 min"
    });
  });

  it("clamps 0 (at start) and a negative/fractional value", () => {
    expect(buildEventReminder("Standup", start, 0, now, "rem_y").dueAt).toBe("2026-07-01T14:00:00.000Z");
    expect(buildEventReminder("Standup", start, 0, now, "rem_y").text).toBe("Standup — starting now");
    expect(buildEventReminder("Standup", start, -5, now, "rem_z").dueAt).toBe("2026-07-01T14:00:00.000Z"); // clamped to 0
    expect(buildEventReminder("Standup", start, 15.9, now, "rem_w").dueAt).toBe("2026-07-01T13:45:00.000Z"); // truncated to 15
  });

  it("links the reminder to its event id (so delete can clean it up)", () => {
    expect(buildEventReminder("Dentist", start, 30, now, "rem_x", "evt_42").eventId).toBe("evt_42");
    expect(buildEventReminder("Dentist", start, 30, now, "rem_x")).not.toHaveProperty("eventId"); // omitted when no event id
  });
});

describe("removeRemindersForEvent — drop the reminders linked to a deleted event (no zombie reminders)", () => {
  const rem = (id: string, eventId?: string): PersistedReminder =>
    ({ createdAt: "2026-01-01T00:00:00Z", dueAt: "2026-07-01T13:30:00Z", id, status: "pending", text: id, ...(eventId ? { eventId } : {}) });

  it("removes ONLY reminders whose eventId matches the deleted event", () => {
    const reminders = [rem("a", "evt_1"), rem("b", "evt_2"), rem("c") /* unlinked */, rem("d", "evt_1")];
    const { kept, removed } = removeRemindersForEvent(reminders, "evt_1");
    expect(removed).toBe(2);
    expect(kept.map((r) => r.id)).toEqual(["b", "c"]); // evt_2 + the unlinked one survive
  });

  it("removes nothing when no reminder is linked to the event", () => {
    const reminders = [rem("a", "evt_2"), rem("b")];
    expect(removeRemindersForEvent(reminders, "evt_1")).toEqual({ kept: reminders, removed: 0 });
  });
});

describe("rescheduleRemindersForEvent — shift a linked reminder when its event moves (no stale fire time)", () => {
  const rem = (id: string, dueAt: string, eventId?: string): PersistedReminder =>
    ({ createdAt: "2026-01-01T00:00:00Z", dueAt, id, status: "pending", text: id, ...(eventId ? { eventId } : {}) });
  const oldStart = new Date("2026-07-01T14:00:00Z");
  const newStart = new Date("2026-07-01T16:00:00Z"); // +2h

  it("shifts ONLY the matching event's reminder by the start delta, leaving others byte-identical", () => {
    const reminders = [
      rem("a", "2026-07-01T13:30:00.000Z", "evt_1"), // 30 min before old start → should move to 15:30 (30 min before new)
      rem("b", "2026-07-01T13:30:00.000Z", "evt_2"), // other event — untouched
      rem("c", "2026-07-01T09:00:00.000Z")           // unlinked — untouched
    ];
    const { next, shifted } = rescheduleRemindersForEvent(reminders, "evt_1", oldStart, newStart);
    expect(shifted).toBe(1);
    expect(next[0]!.dueAt).toBe("2026-07-01T15:30:00.000Z"); // +2h, still 30 min before the new 16:00 start
    expect(next[1]).toBe(reminders[1]);                       // other event untouched (same ref)
    expect(next[2]).toBe(reminders[2]);                       // unlinked untouched
  });

  it("does nothing when the start didn't move (delta 0) or the dueAt is unparseable", () => {
    const r = [rem("a", "2026-07-01T13:30:00.000Z", "evt_1")];
    expect(rescheduleRemindersForEvent(r, "evt_1", oldStart, oldStart)).toEqual({ next: r, shifted: 0 });
    const bad = [rem("a", "not-a-date", "evt_1")];
    expect(rescheduleRemindersForEvent(bad, "evt_1", oldStart, newStart)).toEqual({ next: bad, shifted: 0 });
  });
});

describe("resolveEventIdMatch — exact wins, else unique prefix, else ambiguous/none", () => {
  const events = [{ id: "abc12345xyz" }, { id: "abc99999" }, { id: "def00000" }];
  it("returns the exact match even when it's also a prefix of others", () => {
    expect(resolveEventIdMatch([{ id: "abc" }, { id: "abcd" }], "abc")).toMatchObject({ kind: "match", event: { id: "abc" } });
  });
  it("resolves a unique prefix", () => {
    expect(resolveEventIdMatch(events, "def")).toMatchObject({ kind: "match", event: { id: "def00000" } });
  });
  it("reports ambiguous when a prefix matches several", () => {
    expect(resolveEventIdMatch(events, "abc")).toMatchObject({ kind: "ambiguous", count: 2 });
  });
  it("reports none when nothing matches", () => {
    expect(resolveEventIdMatch(events, "zzz")).toEqual({ kind: "none" });
  });
});

describe("minOfNumbers / maxOfNumbers — reduce-based min/max so a large `.ics` import range computation can't RangeError on `Math.min(...arr)` spread", () => {
  it("returns the min / max of a small array", () => {
    expect(minOfNumbers([3, 1, 2])).toBe(1);
    expect(maxOfNumbers([3, 1, 2])).toBe(3);
    expect(minOfNumbers([-5, 0, 5])).toBe(-5);
    expect(maxOfNumbers([-5, 0, 5])).toBe(5);
  });

  it("handles a single element", () => {
    expect(minOfNumbers([42])).toBe(42);
    expect(maxOfNumbers([42])).toBe(42);
  });

  it("returns the Infinity seeds for an empty array (the documented empty-input fallback; callers guard against empty)", () => {
    expect(minOfNumbers([])).toBe(Infinity);
    expect(maxOfNumbers([])).toBe(-Infinity);
  });

  it("does NOT RangeError on a very large array — `Math.min(...arr)` / `Math.max(...arr)` spread every element as a call argument and overflow the engine's argument-count limit; the reduce never spreads", () => {
    // 200k elements is comfortably past V8's spread argument-count
    // ceiling, where `Math.min(...arr)` throws RangeError.
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    expect(maxOfNumbers(big)).toBe(199_999);
    expect(minOfNumbers(big)).toBe(0);
  });
});

describe("eventsToAvailability — payload rows → availability engine shape", () => {
  it("maps startsAtIso/endsAtIso/title/allDay and skips rows with an unparseable time", () => {
    const out = eventsToAvailability([
      { endsAtIso: "2026-05-25T11:00:00", startsAtIso: "2026-05-25T10:00:00", title: "Standup" },
      { allDay: true, endsAtIso: "2026-05-26T00:00:00", startsAtIso: "2026-05-25T00:00:00", title: "Holiday" },
      { endsAtIso: "nope", startsAtIso: "2026-05-25T12:00:00", title: "Bad" }
    ]);
    expect(out.map((e) => e.title)).toEqual(["Standup", "Holiday"]);
    expect(out[1]!.allDay).toBe(true);
  });
});

describe("formatAvailability — human free/busy summary", () => {
  const win = { from: new Date("2026-05-25T09:00:00"), to: new Date("2026-05-25T17:00:00") };
  it("reports fully free over the window", () => {
    expect(formatAvailability({ busy: [], free: [{ endsAt: win.to, startsAt: win.from }], fullyFree: true }, win))
      .toBe("Free all of 09:00–17:00.");
  });
  it("lists busy blocks (with titles) and the free gaps", () => {
    const out = formatAvailability({
      busy: [{ endsAt: new Date("2026-05-25T11:00:00"), startsAt: new Date("2026-05-25T10:00:00"), titles: ["Standup"] }],
      free: [
        { endsAt: new Date("2026-05-25T10:00:00"), startsAt: win.from },
        { endsAt: win.to, startsAt: new Date("2026-05-25T11:00:00") }
      ],
      fullyFree: false
    }, win);
    expect(out).toContain("Busy: 10:00–11:00 Standup");
    expect(out).toContain("Free: 09:00–10:00, 11:00–17:00");
  });
});

describe("formatConflicts — double-booking summary", () => {
  it("reports no conflicts cleanly", () => {
    expect(formatConflicts([])).toContain("No double-booked events");
  });
  it("lists each overlapping pair with the overlap span", () => {
    const out = formatConflicts([{
      a: { title: "Review", startsAt: new Date("2026-05-25T15:00:00"), endsAt: new Date("2026-05-25T16:00:00") },
      b: { title: "Call", startsAt: new Date("2026-05-25T15:30:00"), endsAt: new Date("2026-05-25T16:30:00") },
      overlapStartsAt: new Date("2026-05-25T15:30:00"),
      overlapEndsAt: new Date("2026-05-25T16:00:00")
    }]);
    expect(out).toContain("1 double-booking");
    expect(out).toContain('"Review"');
    expect(out).toContain('overlaps "Call"');
    expect(out).toContain("15:30–16:00");
  });
});

async function runCalendarConflicts(args: string[], events: Array<Record<string, unknown>>): Promise<{
  readonly error?: string;
  readonly json?: unknown;
  readonly stdout: string[];
  readonly apiPaths: string[];
}> {
  const stdout: string[] = [];
  const apiPaths: string[] = [];
  let json: unknown;
  const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
  const helpers: CalendarCommandHelpers = {
    apiRequest: async (_io, _command, path) => { apiPaths.push(path); return { events }; },
    writeOutput: (_io, value) => { json = value; }
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerCalendarCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "calendar", "conflicts", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { apiPaths, error, json, stdout };
}

describe("muse calendar conflicts — double-booking over a window (API path, contract-faithful events seam)", () => {
  const window = ["--from", "2026-05-25T09:00:00Z", "--to", "2026-05-25T23:00:00Z"];

  it("flags an overlapping pair from the fetched events (--json)", async () => {
    const r = await runCalendarConflicts([...window, "--json"], [
      { endsAtIso: "2026-05-25T16:00:00Z", startsAtIso: "2026-05-25T15:00:00Z", title: "Review" },
      { endsAtIso: "2026-05-25T16:30:00Z", startsAtIso: "2026-05-25T15:30:00Z", title: "Call" }
    ]);
    expect(r.error).toBeUndefined();
    expect(r.apiPaths[0]).toContain("/api/calendar/events?");
    expect(r.json).toHaveLength(1);
  });

  it("reports no double-bookings when events don't overlap", async () => {
    const r = await runCalendarConflicts(window, [
      { endsAtIso: "2026-05-25T10:00:00Z", startsAtIso: "2026-05-25T09:00:00Z", title: "A" },
      { endsAtIso: "2026-05-25T12:00:00Z", startsAtIso: "2026-05-25T11:00:00Z", title: "B" }
    ]);
    expect(r.error).toBeUndefined();
    expect(r.stdout.join("\n")).toContain("No double-booked events");
  });

  it("rejects a non-ISO --from before fetching", async () => {
    const r = await runCalendarConflicts(["--from", "nope"], []);
    expect(r.error).toContain("--from / --to must be ISO 8601 timestamps");
  });
});

async function runCalendarFree(args: string[], events: Array<Record<string, unknown>>): Promise<{
  readonly error?: string;
  readonly json?: unknown;
  readonly stdout: string[];
  readonly apiPaths: string[];
}> {
  const stdout: string[] = [];
  const apiPaths: string[] = [];
  let json: unknown;
  const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
  const helpers: CalendarCommandHelpers = {
    apiRequest: async (_io, _command, path) => { apiPaths.push(path); return { events }; },
    writeOutput: (_io, value) => { json = value; }
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerCalendarCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "calendar", "free", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { apiPaths, error, json, stdout };
}

describe("muse calendar free — free/busy over a window (API path, contract-faithful events seam)", () => {
  const window = ["--from", "2026-05-25T09:00:00Z", "--to", "2026-05-25T17:00:00Z"];

  it("computes busy + free from the fetched events (--json)", async () => {
    const r = await runCalendarFree([...window, "--json"], [
      { endsAtIso: "2026-05-25T11:00:00Z", startsAtIso: "2026-05-25T10:00:00Z", title: "Standup" }
    ]);
    expect(r.error).toBeUndefined();
    expect(r.apiPaths[0]).toContain("/api/calendar/events?");
    const out = r.json as { fullyFree: boolean; busy: unknown[]; free: unknown[] };
    expect(out.fullyFree).toBe(false);
    expect(out.busy).toHaveLength(1);
    expect(out.free).toHaveLength(2);
  });

  it("reports fully free when there are no events", async () => {
    const r = await runCalendarFree(window, []);
    expect(r.error).toBeUndefined();
    expect(r.stdout.join("\n")).toContain("Free all of");
  });

  it("rejects a non-numeric --min-minutes before computing", async () => {
    const r = await runCalendarFree([...window, "--min-minutes", "lots"], []);
    expect(r.error).toContain("--min-minutes must be a number");
  });
});

describe("parseEventStart — --at parsing for muse calendar add", () => {
  it("parses an ISO-8601 timestamp", () => {
    const d = parseEventStart("2026-05-30T15:00:00");
    expect(d?.toISOString().slice(0, 16)).toBe(new Date("2026-05-30T15:00:00").toISOString().slice(0, 16));
  });
  it("parses a relative phrase to a future instant", () => {
    const now = () => new Date("2026-05-20T09:00:00");
    const d = parseEventStart("tomorrow", now);
    expect(d).toBeDefined();
    expect(d!.getTime()).toBeGreaterThan(now().getTime());
  });
  it("returns undefined for an unparseable value", () => {
    expect(parseEventStart("not-a-time")).toBeUndefined();
  });
});

describe("muse calendar add — create a local event from the terminal", () => {
  let dir: string;
  let prevFile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-cal-add-"));
    prevFile = process.env.MUSE_CALENDAR_FILE;
    process.env.MUSE_CALENDAR_FILE = join(dir, "calendar.json");
  });
  afterEach(() => {
    if (prevFile === undefined) delete process.env.MUSE_CALENDAR_FILE;
    else process.env.MUSE_CALENDAR_FILE = prevFile;
  });

  async function runAdd(args: string[]): Promise<{ error?: string; stdout: string[] }> {
    const stdout: string[] = [];
    const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
    const helpers: CalendarCommandHelpers = { apiRequest: async () => ({}), writeOutput: (_io, v) => stdout.push(JSON.stringify(v)) };
    let error: string | undefined;
    try {
      const program = new Command();
      program.exitOverride();
      registerCalendarCommands(program, io, helpers);
      await program.parseAsync(["node", "muse", "calendar", "add", ...args]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return { error, stdout };
  }

  it("writes the event to the local calendar file (readable back by the provider)", async () => {
    const r = await runAdd(["Dentist", "appointment", "--at", "2026-05-30T15:00:00"]);
    expect(r.error).toBeUndefined();
    expect(r.stdout.join("")).toContain("Created: Dentist appointment");
    const events = await new LocalCalendarProvider({ file: process.env.MUSE_CALENDAR_FILE! }).listEvents({
      from: new Date("2026-05-30T00:00:00"),
      to: new Date("2026-05-31T00:00:00")
    });
    expect(events.map((e) => e.title)).toContain("Dentist appointment");
    const created = events.find((e) => e.title === "Dentist appointment")!;
    expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(60 * 60_000); // default 60 min
  });

  it("--for sets the duration", async () => {
    await runAdd(["Standup", "--at", "2026-05-30T09:00:00", "--for", "15"]);
    const events = await new LocalCalendarProvider({ file: process.env.MUSE_CALENDAR_FILE! }).listEvents({
      from: new Date("2026-05-30T00:00:00"),
      to: new Date("2026-05-31T00:00:00")
    });
    const standup = events.find((e) => e.title === "Standup")!;
    expect(standup.endsAt.getTime() - standup.startsAt.getTime()).toBe(15 * 60_000);
  });

  it("records a time-parse weakness when --at FAILS to parse (the dead axis now has a live producer); a good --at records nothing", async () => {
    const prevWeak = process.env.MUSE_WEAKNESSES_FILE;
    process.env.MUSE_WEAKNESSES_FILE = join(dir, "weaknesses.json");
    try {
      const { readWeaknesses } = await import("@muse/stores");
      const bad = await runAdd(["Team meeting", "--at", "blarghday next quux"]);
      expect(bad.error).toMatch(/--at must be/);
      expect((await readWeaknesses(process.env.MUSE_WEAKNESSES_FILE)).some((e) => e.axis === "time-parse")).toBe(true);
      // a VALID --at takes the success path → no time-parse weakness for it
      await runAdd(["Lunch", "--at", "2026-05-30T12:00:00"]);
      expect((await readWeaknesses(process.env.MUSE_WEAKNESSES_FILE)).filter((e) => e.axis === "time-parse")).toHaveLength(1);
    } finally {
      if (prevWeak === undefined) delete process.env.MUSE_WEAKNESSES_FILE;
      else process.env.MUSE_WEAKNESSES_FILE = prevWeak;
    }
  });

  async function runEvents(args: string[], apiRequest: CalendarCommandHelpers["apiRequest"]): Promise<{ error?: string; stdout: string }> {
    const stdout: string[] = [];
    const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
    const helpers: CalendarCommandHelpers = { apiRequest, writeOutput: (_io, v) => stdout.push(JSON.stringify(v)) };
    try {
      const program = new Command();
      program.exitOverride();
      registerCalendarCommands(program, io, helpers);
      await program.parseAsync(["node", "muse", "calendar", "events", ...args]);
      return { stdout: stdout.join("") };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause), stdout: stdout.join("") };
    }
  }

  it("events: an unreachable API falls back to the LOCAL calendar (you can list what you added)", async () => {
    await runAdd(["Dentist", "--at", "2026-05-30T15:00:00"]); // add is local-by-design
    const unreachable: CalendarCommandHelpers["apiRequest"] = async () => { throw new Error("muse: Muse API not reachable at http://127.0.0.1:3030"); };
    const r = await runEvents(["--from", "2026-05-30T00:00:00", "--to", "2026-05-31T00:00:00"], unreachable);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain("Dentist");
  });

  it("events: a REAL api error (NOT unreachable) still throws — fallback never masks a 500", async () => {
    const serverError: CalendarCommandHelpers["apiRequest"] = async () => { throw new Error("HTTP 500 internal server error"); };
    const r = await runEvents([], serverError);
    expect(r.error).toContain("500");
  });

  it("rejects an unparseable --at with an actionable error (no event written)", async () => {
    const r = await runAdd(["Thing", "--at", "whenever"]);
    expect(r.error).toContain("ISO-8601");
    const events = await new LocalCalendarProvider({ file: process.env.MUSE_CALENDAR_FILE! }).listEvents({
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01")
    });
    expect(events).toHaveLength(0);
  });
});

describe("muse calendar delete — cancel a local event by id", () => {
  let dir: string;
  let prevFile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-cal-del-"));
    prevFile = process.env.MUSE_CALENDAR_FILE;
    process.env.MUSE_CALENDAR_FILE = join(dir, "calendar.json");
  });
  afterEach(() => {
    if (prevFile === undefined) delete process.env.MUSE_CALENDAR_FILE;
    else process.env.MUSE_CALENDAR_FILE = prevFile;
  });

  async function run(args: string[]): Promise<{ error?: string; out: string }> {
    const out: string[] = [];
    const io = { stderr: (m: string) => out.push(m), stdout: (m: string) => out.push(m) };
    const helpers: CalendarCommandHelpers = { apiRequest: async () => ({}), writeOutput: (_io, v) => out.push(JSON.stringify(v)) };
    let error: string | undefined;
    try {
      const program = new Command();
      program.exitOverride();
      registerCalendarCommands(program, io, helpers);
      await program.parseAsync(["node", "muse", "calendar", ...args]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return { error, out: out.join("") };
  }

  it("deletes an event resolved by short-id prefix, gone from the store afterwards", async () => {
    const file = process.env.MUSE_CALENDAR_FILE!;
    const created = await new LocalCalendarProvider({ file }).createEvent({
      endsAt: new Date("2026-05-30T16:00:00"), startsAt: new Date("2026-05-30T15:00:00"), title: "Dentist"
    });
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const r = await run(["delete", created.id.slice(0, 8)]);
    expect(r.error).toBeUndefined();
    expect(r.out).toContain("Cancelled: Dentist");
    expect(process.exitCode ?? 0).toBe(0);
    process.exitCode = prevExit;
    const left = await new LocalCalendarProvider({ file }).listEvents({ from: new Date("2000-01-01"), to: new Date("2100-01-01") });
    expect(left).toHaveLength(0);
  });

  it("an unknown id exits 1 and deletes nothing", async () => {
    const file = process.env.MUSE_CALENDAR_FILE!;
    await new LocalCalendarProvider({ file }).createEvent({
      endsAt: new Date("2026-05-30T16:00:00"), startsAt: new Date("2026-05-30T15:00:00"), title: "Keep"
    });
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const r = await run(["delete", "nope-no-such-id"]);
    expect(r.out).toContain("no event matches id");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
    const left = await new LocalCalendarProvider({ file }).listEvents({ from: new Date("2000-01-01"), to: new Date("2100-01-01") });
    expect(left).toHaveLength(1);
  });

  it("--at reschedules and preserves the original duration", async () => {
    const file = process.env.MUSE_CALENDAR_FILE!;
    const created = await new LocalCalendarProvider({ file }).createEvent({
      endsAt: new Date("2026-05-30T16:00:00"), startsAt: new Date("2026-05-30T15:00:00"), title: "Dentist"
    }); // 60 min
    const r = await run(["edit", created.id.slice(0, 8), "--at", "2026-05-30T17:00:00"]);
    expect(r.error).toBeUndefined();
    expect(r.out).toContain("Updated: Dentist");
    const events = await new LocalCalendarProvider({ file }).listEvents({ from: new Date("2000-01-01"), to: new Date("2100-01-01") });
    const e = events.find((ev) => ev.id === created.id)!;
    expect(e.startsAt.toISOString()).toBe(new Date("2026-05-30T17:00:00").toISOString());
    expect(e.endsAt.getTime() - e.startsAt.getTime()).toBe(60 * 60_000); // duration preserved
  });

  it("--title renames; --for changes duration", async () => {
    const file = process.env.MUSE_CALENDAR_FILE!;
    const created = await new LocalCalendarProvider({ file }).createEvent({
      endsAt: new Date("2026-05-30T16:00:00"), startsAt: new Date("2026-05-30T15:00:00"), title: "Old"
    });
    await run(["edit", created.id.slice(0, 8), "--title", "New name", "--for", "30"]);
    const events = await new LocalCalendarProvider({ file }).listEvents({ from: new Date("2000-01-01"), to: new Date("2100-01-01") });
    const e = events.find((ev) => ev.id === created.id)!;
    expect(e.title).toBe("New name");
    expect(e.endsAt.getTime() - e.startsAt.getTime()).toBe(30 * 60_000);
  });

  it("show renders an event's full details incl notes; unknown id exits 1", async () => {
    const file = process.env.MUSE_CALENDAR_FILE!;
    const created = await new LocalCalendarProvider({ file }).createEvent({
      endsAt: new Date("2026-05-30T16:00:00"), location: "Room 4", notes: "bring the Q3 deck",
      startsAt: new Date("2026-05-30T15:00:00"), title: "Review"
    });
    const r = await run(["show", created.id.slice(0, 8)]);
    expect(r.error).toBeUndefined();
    expect(r.out).toContain("Review");
    expect(r.out).toContain("@ Room 4");
    expect(r.out).toContain("bring the Q3 deck");

    const prevExit = process.exitCode;
    process.exitCode = 0;
    const miss = await run(["show", "no-such-id"]);
    expect(miss.out).toContain("no event matches id");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });

  it("edit with no fields errors and an unknown id exits 1", async () => {
    const file = process.env.MUSE_CALENDAR_FILE!;
    const created = await new LocalCalendarProvider({ file }).createEvent({
      endsAt: new Date("2026-05-30T16:00:00"), startsAt: new Date("2026-05-30T15:00:00"), title: "Keep"
    });
    expect((await run(["edit", created.id.slice(0, 8)])).error).toContain("at least one of");
    const prevExit = process.exitCode;
    process.exitCode = 0;
    expect((await run(["edit", "no-such", "--title", "x"])).out).toContain("no event matches id");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });
});

describe("muse calendar export — iCalendar (.ics) over the API events seam", () => {
  async function runExport(args: string[], events: Array<Record<string, unknown>>): Promise<{ readonly stdout: string; readonly apiPaths: string[]; readonly error?: string }> {
    const stdout: string[] = [];
    const apiPaths: string[] = [];
    const io = { stderr: () => {}, stdout: (line: string) => stdout.push(line) };
    const helpers: CalendarCommandHelpers = {
      apiRequest: async (_io, _command, path) => { apiPaths.push(path); return { events }; },
      writeOutput: () => {}
    };
    let error: string | undefined;
    try {
      const program = new Command();
      program.exitOverride();
      registerCalendarCommands(program, io, helpers);
      await program.parseAsync(["node", "muse", "calendar", "export", ...args]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return { apiPaths, error, stdout: stdout.join("") };
  }

  it("emits a VCALENDAR with a VEVENT per fetched event", async () => {
    const r = await runExport(["--from", "2026-06-01T00:00:00Z", "--to", "2026-06-02T00:00:00Z"], [
      { id: "e1", title: "Standup", startsAtIso: "2026-06-01T09:00:00Z", endsAtIso: "2026-06-01T09:30:00Z", location: "Zoom" }
    ]);
    expect(r.error).toBeUndefined();
    expect(r.apiPaths[0]).toContain("/api/calendar/events?");
    expect(r.stdout).toContain("BEGIN:VCALENDAR");
    expect(r.stdout).toContain("SUMMARY:Standup");
    expect(r.stdout).toContain("DTSTART:20260601T090000Z");
    expect(r.stdout).toContain("LOCATION:Zoom");
  });

  it("rejects a malformed --from before fetching", async () => {
    const r = await runExport(["--from", "not-a-date"], []);
    expect(r.error).toMatch(/ISO 8601/u);
    expect(r.apiPaths).toEqual([]);
  });
});
