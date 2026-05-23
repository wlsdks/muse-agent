import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalCalendarProvider } from "@muse/calendar";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eventsToAvailability,
  formatAvailability,
  maxOfNumbers,
  minOfNumbers,
  parseEventStart,
  registerCalendarCommands,
  resolveEventIdMatch,
  type CalendarCommandHelpers
} from "./commands-calendar.js";

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
