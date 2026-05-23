import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFollowups, writeReminders, type PersistedFollowup, type PersistedReminder } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { formatEvents, formatTasks, formatWeatherLine, parseLookaheadHours, readDueFollowups, readDueReminders, relativeDueTag, resolveTodayWeatherLine } from "./commands-today.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function hasTerminalControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f) return true;
  }
  return false;
}

describe("formatEvents terminal-injection hardening (goal 346/347 sibling — calendar)", () => {
  it("strips control sequences from a third-party event title", () => {
    const out = formatEvents([
      {
        id: "e1",
        startsAtIso: "2026-05-18T15:00:00.000Z",
        title: `${ESC}[2J${ESC}]0;pwned${BEL}Hostile invite\nsecond line`
      }
    ]);
    expect(hasTerminalControl(out)).toBe(false);
    expect(out).toContain("Hostile invite second line");
    expect(out).toContain("15:00 —");
  });

  it("leaves a clean event untouched + preserves the empty/unconfigured states", () => {
    expect(formatEvents([{ id: "e", startsAtIso: "2026-05-18T09:30:00.000Z", title: "Standup" }]))
      .toBe("\nUpcoming (1):\n  - 09:30 — Standup\n");
    expect(formatEvents(undefined)).toBe("\nUpcoming: (calendar not configured)\n");
    expect(formatEvents([])).toBe("\nUpcoming: (no calendar events in window)\n");
  });
});

describe("relativeDueTag — urgency tag for muse today tasks", () => {
  const now = new Date(2026, 4, 20, 9, 0); // May 20 2026
  const at = (d: number) => new Date(2026, 4, d, 12, 0).toISOString();
  it("tags overdue / today / tomorrow / future relative to today", () => {
    expect(relativeDueTag(at(18), now)).toBe(" (overdue)");
    expect(relativeDueTag(at(20), now)).toBe(" (today)");
    expect(relativeDueTag(at(21), now)).toBe(" (tomorrow)");
    expect(relativeDueTag(at(25), now)).toBe(" (in 5 days)");
  });
  it("a due time LATER today still reads (today), not tomorrow", () => {
    expect(relativeDueTag(new Date(2026, 4, 20, 23, 30).toISOString(), now)).toBe(" (today)");
  });
  it("undated / unparseable → no tag", () => {
    expect(relativeDueTag(undefined, now)).toBe("");
    expect(relativeDueTag("not-a-date", now)).toBe("");
  });
});

describe("formatTasks — daily view shows each task's urgency", () => {
  const now = new Date(2026, 4, 20, 9, 0);
  it("renders the due tag alongside the title", () => {
    const out = formatTasks([
      { dueAt: new Date(2026, 4, 18, 9, 0).toISOString(), id: "t1abc", title: "Pay rent" },
      { id: "t2def", title: "Someday idea" }
    ], now);
    expect(out).toContain("Pay rent (overdue)");
    expect(out).toContain("Someday idea\n"); // undated → bare title, no tag
    expect(out).not.toContain("Someday idea (");
  });
});

describe("muse today — weather line", () => {
  const fakeProvider = {
    geocode: async () => ({ latitude: 37.57, longitude: 126.98, name: "Seoul" }),
    currentWeather: async () => ({ code: 0, condition: "clear sky", temperatureC: 21 })
  };

  it("formatWeatherLine renders a Weather: line, or empty when absent", () => {
    expect(formatWeatherLine("Seoul: clear sky, 21°C")).toBe("\nWeather: Seoul: clear sky, 21°C\n");
    expect(formatWeatherLine(undefined)).toBe("");
    expect(formatWeatherLine("   ")).toBe("");
  });

  it("resolveTodayWeatherLine fetches for the configured home location", async () => {
    const line = await resolveTodayWeatherLine({ MUSE_WEATHER_LOCATION: "Seoul" }, fakeProvider);
    expect(line).toContain("Seoul");
    expect(line).toContain("clear sky");
  });

  it("returns undefined when no home location is configured (no weather line)", async () => {
    expect(await resolveTodayWeatherLine({}, fakeProvider)).toBeUndefined();
    expect(await resolveTodayWeatherLine({ MUSE_WEATHER_LOCATION: "   " }, fakeProvider)).toBeUndefined();
  });
});

describe("parseLookaheadHours", () => {
  it("absent or blank → the 24h default", () => {
    expect(parseLookaheadHours(undefined)).toBe(24);
    expect(parseLookaheadHours("")).toBe(24);
    expect(parseLookaheadHours("   ")).toBe(24);
  });

  it("accepts a genuine number, truncating and clamping to the 168h max", () => {
    expect(parseLookaheadHours("12")).toBe(12);
    expect(parseLookaheadHours(" 48 ")).toBe(48);
    expect(parseLookaheadHours("36.9")).toBe(36);
    expect(parseLookaheadHours("9999")).toBe(168); // clamp high
    expect(parseLookaheadHours("1")).toBe(1);
  });

  it("rejects a unit slip / non-numeric / below-1 instead of silently defaulting to 24", () => {
    expect(() => parseLookaheadHours("48abc")).toThrow(/--lookahead-hours must be an integer in \[1, 168\]/u);
    expect(() => parseLookaheadHours("abc")).toThrow(/got 'abc'/u);
    expect(() => parseLookaheadHours("0")).toThrow(/\[1, 168\]/u);
    expect(() => parseLookaheadHours("-5")).toThrow(/\[1, 168\]/u);
    expect(() => parseLookaheadHours("1O")).toThrow(/got '1O'/u);
  });
});

describe("readDueReminders ordering — by parsed instant, not lexicographic dueAt", () => {
  function file(): string {
    return join(mkdtempSync(join(tmpdir(), "muse-today-rem-")), "reminders.json");
  }
  function reminder(overrides: Partial<PersistedReminder>): PersistedReminder {
    return { createdAt: "2026-05-22T00:00:00.000Z", dueAt: "2026-05-22T12:00:00.000Z", id: "r", status: "pending", text: "x", ...overrides };
  }

  it("orders a timezone-offset dueAt by its real instant (a lexicographic sort would invert it)", async () => {
    const f = file();
    // a: 2026-05-22T23:00:00-05:00 == 2026-05-23T04:00:00Z (LATER instant)
    // b: 2026-05-23T01:00:00Z (EARLIER instant)
    // Lexicographically "2026-05-22T23…" < "2026-05-23T01…" → a would sort first; by instant b is first.
    await writeReminders(f, [
      reminder({ dueAt: "2026-05-22T23:00:00-05:00", id: "a", text: "later" }),
      reminder({ dueAt: "2026-05-23T01:00:00Z", id: "b", text: "earlier" })
    ]);
    const due = await readDueReminders(f, new Date("2026-06-01T00:00:00Z"));
    expect(due.map((r) => r.id)).toEqual(["b", "a"]);
  });
})

describe("readDueFollowups ordering — by parsed instant, not lexicographic scheduledFor", () => {
  function file(): string {
    return join(mkdtempSync(join(tmpdir(), "muse-today-fu-")), "followups.json");
  }
  function followup(overrides: Partial<PersistedFollowup>): PersistedFollowup {
    return { createdAt: "2026-05-22T00:00:00.000Z", id: "f", scheduledFor: "2026-05-22T12:00:00.000Z", status: "scheduled" as const, summary: "x", userId: "stark", ...overrides };
  }
  it("orders a timezone-offset scheduledFor by its real instant", async () => {
    const f = file();
    await writeFollowups(f, [
      followup({ id: "a", scheduledFor: "2026-05-22T23:00:00-05:00", summary: "later" }), // 05-23 04:00Z
      followup({ id: "b", scheduledFor: "2026-05-23T01:00:00Z", summary: "earlier" })
    ]);
    const due = await readDueFollowups(f, new Date("2026-06-01T00:00:00Z"));
    expect(due.map((r) => r.id)).toEqual(["b", "a"]);
  });
})
