import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFollowups, writeReminders, type Contact, type PersistedFollowup, type PersistedReminder } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { annotateEventTitle, formatConnectionsSection, formatEpisodeRevisitLine, formatEvents, formatHeadlines, formatLargestBreak, formatNextEvent, formatOverdue, formatRevisitSection, formatStaleTasksSection, formatTasks, formatTodayBrief, formatTodayConflicts, formatWeatherLine, largestBreakBetweenEvents, parseLookaheadHours, pickConnectionQuery, readDueFollowups, readDueReminders, readUpcomingBirthdays, relativeDueTag, resolveTodayFeedHeadlines, resolveTodayWeatherLine, selectEpisodeToRevisit, selectStaleTasks, selectTodayOverdue } from "./commands-today.js";

describe("largestBreakBetweenEvents — your longest focus window between today's meetings", () => {
  const now = new Date("2026-06-05T08:00:00"); // local morning
  const ev = (startIso: string, endIso: string) => ({ startsAtIso: startIso, endsAtIso: endIso });

  it("returns the LARGEST gap between meetings (back-to-back/overlap merged away)", () => {
    const slot = largestBreakBetweenEvents([
      ev("2026-06-05T09:00:00", "2026-06-05T09:30:00"),
      ev("2026-06-05T12:00:00", "2026-06-05T13:00:00"), // 9:30–12:00 = 2h30 (largest)
      ev("2026-06-05T15:00:00", "2026-06-05T16:00:00")  // 13:00–15:00 = 2h
    ], now)!;
    expect(slot.startsAt.getHours()).toBe(9);
    expect(slot.startsAt.getMinutes()).toBe(30);
    expect(slot.endsAt.getHours()).toBe(12);
  });

  it("is null with no MEANINGFUL between gap: back-to-back, a <45min gap, a single event, or none", () => {
    expect(largestBreakBetweenEvents([ev("2026-06-05T09:00:00", "2026-06-05T10:00:00"), ev("2026-06-05T10:00:00", "2026-06-05T11:00:00")], now)).toBeNull(); // back-to-back merges
    expect(largestBreakBetweenEvents([ev("2026-06-05T09:00:00", "2026-06-05T09:30:00"), ev("2026-06-05T10:00:00", "2026-06-05T11:00:00")], now)).toBeNull(); // 30-min gap < 45
    expect(largestBreakBetweenEvents([ev("2026-06-05T14:00:00", "2026-06-05T15:00:00")], now)).toBeNull(); // single event — no trailing block reported
    expect(largestBreakBetweenEvents([], now)).toBeNull();
  });
});

describe("formatLargestBreak", () => {
  it("renders the free-block line, empty when null", () => {
    const out = formatLargestBreak({ startsAt: new Date("2026-06-05T09:30:00"), endsAt: new Date("2026-06-05T12:00:00") });
    expect(out).toContain("🟢 Biggest free block:");
    expect(out).toContain("(2h 30m)");
    expect(out).toContain("between today's events");
    expect(formatLargestBreak(null)).toBe("");
  });
});

const contact = (over: Partial<Contact> & { name: string }): Contact => ({ id: over.name.toLowerCase().replace(/\s+/gu, "_"), ...over });

describe("annotateEventTitle — surface a known contact's relationship in an event title", () => {
  const dana = contact({ name: "Dana Wu", relationship: "manager" });
  const sarah = contact({ name: "Sarah", relationship: "wife", aliases: ["Sare"] });
  const bob = contact({ name: "Bob Lee" }); // no relationship

  it("annotates a first-name mention with the relationship", () => {
    expect(annotateEventTitle("Lunch with Dana", [dana, sarah, bob])).toBe(" (your manager)");
    expect(annotateEventTitle("Dana / me 1:1", [dana])).toBe(" (your manager)");
  });

  it("matches on an alias too", () => {
    expect(annotateEventTitle("Dinner with Sare", [sarah])).toBe(" (your wife)");
  });

  it("does NOT annotate a contact with no relationship, nor an unmentioned one", () => {
    expect(annotateEventTitle("Sync with Bob", [bob])).toBe("");        // Bob has no relationship
    expect(annotateEventTitle("Standup", [dana, sarah])).toBe("");      // nobody named
    expect(annotateEventTitle("Project review", [dana])).toBe("");
  });

  it("lists multiple matched people with their roles", () => {
    expect(annotateEventTitle("Dinner with Dana and Sarah", [dana, sarah])).toBe(" (Dana: your manager; Sarah: your wife)");
  });
});

describe("muse today — Birthdays section (the brief's birthdays, surfaced in the on-demand digest)", () => {
  const base = { generatedAt: "2026-06-04T09:00:00Z", lookaheadHours: 24 };

  it("renders a Birthdays section with today / tomorrow / in-N-days wording", () => {
    const out = formatTodayBrief({ ...base, birthdays: [{ name: "Zelda", daysUntil: 0 }, { name: "Bob", daysUntil: 1 }, { name: "Wu", daysUntil: 3 }] }, true);
    expect(out).toMatch(/Birthdays \(3\):/u);
    expect(out).toContain("🎂 Zelda — today");
    expect(out).toContain("🎂 Bob — tomorrow");
    expect(out).toContain("🎂 Wu — in 3 days");
  });

  it("omits the section entirely when there are no upcoming birthdays", () => {
    expect(formatTodayBrief({ ...base }, true)).not.toMatch(/Birthdays/u);
    expect(formatTodayBrief({ ...base, birthdays: [] }, true)).not.toMatch(/Birthdays/u);
  });

  it("readUpcomingBirthdays returns within-a-week birthdays (name + daysUntil), skipping contacts with no birthday or out of window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-today-bday-"));
    const file = join(dir, "contacts.json");
    const now = new Date("2026-06-04T09:00:00Z");
    const mmdd = (d: Date): string => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const inDays = (n: number): Date => new Date(now.getTime() + n * 86_400_000);
    writeFileSync(file, JSON.stringify({ contacts: [
      { id: "c1", name: "Zelda", birthday: mmdd(now) },        // today
      { id: "c2", name: "Bob", birthday: mmdd(inDays(3)) },    // in 3 days
      { id: "c3", name: "NoBday", email: "x@y.com" },          // no birthday → skipped
      { id: "c4", name: "FarOff", birthday: mmdd(inDays(40)) } // outside the 7-day window → skipped
    ] }), "utf8");
    const out = await readUpcomingBirthdays(file, now);
    expect(out.map((b) => b.name)).toEqual(["Zelda", "Bob"]);
    expect(out.find((b) => b.name === "Zelda")?.daysUntil).toBe(0);
    expect(out.find((b) => b.name === "Bob")?.daysUntil).toBe(3);
  });
});

const ESC = String.fromCharCode(27);

describe("pickConnectionQuery — build a recall query from today's most concrete items", () => {
  it("joins task + event titles (tasks first), capped, ignores empties", () => {
    const q = pickConnectionQuery({
      events: [{ title: "Vendor sync" }],
      tasks: [{ title: "Ship the Q3 deck" }, { title: "  " }]
    });
    expect(q).toContain("Ship the Q3 deck");
    expect(q).toContain("Vendor sync");
  });
  it("returns empty string when there are no tasks or events", () => {
    expect(pickConnectionQuery({})).toBe("");
  });
});

describe("formatConnectionsSection — render the proactive 'Related in your brain' block", () => {
  it("renders source-labelled hits, or nothing when empty", () => {
    expect(formatConnectionsSection([])).toBe("");
    const out = formatConnectionsSection([
      { ref: "projects/ssl.md", score: 0.7, snippet: "renew certs quarterly", source: "notes" },
      { ref: "ep1", score: 0.6, snippet: "discussed TLS rotation", source: "episodes" }
    ]);
    expect(out).toContain("Related in your brain");
    expect(out).toContain("ssl.md");
    expect(out).toContain("[episodes]");
  });
});

describe("selectStaleTasks — GTD nudge for open + undated tasks that rotted", () => {
  const NOW = Date.parse("2026-05-28T00:00:00Z");
  const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
  const task = (id: string, title: string, status: string, createdAt: string, dueAt?: string) =>
    ({ id, title, status, createdAt, ...(dueAt ? { dueAt } : {}) });

  it("picks open + undated tasks older than the threshold, oldest first", () => {
    const stale = selectStaleTasks([
      task("1", "fresh", "open", daysAgo(3)),
      task("2", "old undated", "open", daysAgo(40)),
      task("3", "older undated", "open", daysAgo(90))
    ], NOW);
    expect(stale.map((t) => t.title)).toEqual(["older undated", "old undated"]);
  });

  it("excludes dated tasks (today's due view already shows them) and done tasks", () => {
    const stale = selectStaleTasks([
      task("1", "old but dated", "open", daysAgo(40), "2026-06-01T00:00:00Z"),
      task("2", "old but done", "done", daysAgo(40)),
      task("3", "genuinely stale", "open", daysAgo(40))
    ], NOW);
    expect(stale.map((t) => t.title)).toEqual(["genuinely stale"]);
  });

  it("skips unparseable createdAt and caps the list at 5", () => {
    expect(selectStaleTasks([task("x", "bad", "open", "not-a-date")], NOW)).toEqual([]);
    const many = Array.from({ length: 9 }, (_v, i) => task(String(i), `t${i.toString()}`, "open", daysAgo(20 + i)));
    expect(selectStaleTasks(many, NOW)).toHaveLength(5);
  });
});

describe("formatStaleTasksSection — proactive GTD nudge block in today", () => {
  it("is empty when none are stale", () => {
    expect(formatStaleTasksSection([])).toBe("");
  });
  it("renders the age + title", () => {
    const out = formatStaleTasksSection([{ id: "1", title: "renew the domain", ageDays: 42.7 }]);
    expect(out).toContain("Open a while — still relevant?");
    expect(out).toContain("[42d] renew the domain");
  });
});

describe("selectEpisodeToRevisit — 'remember when' past-session resurfacing", () => {
  const NOW = Date.parse("2026-05-28T00:00:00Z");
  const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
  const ep = (summary: string, endedDaysAgo: number) => ({ summary, endedAt: daysAgo(endedDaysAgo) });

  it("returns the due episode with the largest interval crossed (oldest memory)", () => {
    const got = selectEpisodeToRevisit([
      ep("recent chat", 3), // due @3
      ep("not due", 5),
      ep("old decision", 90) // due @90 — preferred (largest interval)
    ], NOW);
    expect(got?.summary).toBe("old decision");
    expect(got?.intervalDays).toBe(90);
  });

  it("returns undefined when no episode's age lands on an interval", () => {
    expect(selectEpisodeToRevisit([ep("a", 2), ep("b", 5), ep("c", 100)], NOW)).toBeUndefined();
  });

  it("skips unparseable endedAt", () => {
    expect(selectEpisodeToRevisit([{ summary: "bad", endedAt: "nope" }], NOW)).toBeUndefined();
  });

  it("formats a one-line '💭 N days ago' resurface, or nothing", () => {
    expect(formatEpisodeRevisitLine(undefined)).toBe("");
    const line = formatEpisodeRevisitLine({ summary: "decided to\n  cut the Q3 budget", intervalDays: 7, ageDays: 7.4 });
    expect(line).toContain("💭 7 days ago: decided to cut the Q3 budget");
  });

  it("uses singular 'day' at the 1-day resurface bucket (the most common one)", () => {
    const line = formatEpisodeRevisitLine({ summary: "cut the Q3 budget", intervalDays: 1, ageDays: 1.4 });
    expect(line).toContain("💭 1 day ago: cut the Q3 budget");
    expect(line).not.toContain("1 days ago");
  });
});

describe("formatRevisitSection — proactive spaced-revisit block in today", () => {
  it("is empty when nothing is due (silent most days)", () => {
    expect(formatRevisitSection([])).toBe("");
  });
  it("renders due notes with their interval, filename only", () => {
    const out = formatRevisitSection([
      { path: "notes/inbox/q3-budget.md", intervalDays: 7 },
      { path: "onboarding.md", intervalDays: 35 }
    ]);
    expect(out).toContain("Worth revisiting");
    expect(out).toContain("[7d] q3-budget.md");
    expect(out).toContain("[35d] onboarding.md");
    expect(out).not.toContain("notes/inbox/"); // filename only, not the path
  });
});
const BEL = String.fromCharCode(7);

function hasTerminalControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f) return true;
  }
  return false;
}

describe("formatEvents terminal-injection hardening (sibling — calendar)", () => {
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

describe("formatTasks — daily brief leads with imminent, collapses the long tail", () => {
  const now = new Date(2026, 4, 20, 9, 0);
  it("shows tasks due within the window with their tag and collapses the rest", () => {
    const out = formatTasks([
      { dueAt: new Date(2026, 4, 18, 9, 0).toISOString(), id: "t1abc", title: "Pay rent" },
      { dueAt: new Date(2026, 4, 20, 18, 0).toISOString(), id: "t2def", title: "Call plumber" },
      { dueAt: new Date(2026, 8, 1, 9, 0).toISOString(), id: "t3ghi", title: "Far future task" },
      { id: "t4jkl", title: "Someday idea" }
    ], now, 24);
    expect(out).toContain("Tasks due ≤24h (2):");
    expect(out).toContain("Pay rent (overdue)"); // overdue counts as imminent
    expect(out).toContain("Call plumber (today)");
    // The far-future and the undated task are the long tail — collapsed, not dumped.
    expect(out).not.toContain("Far future task");
    expect(out).not.toContain("Someday idea");
    expect(out).toContain("+2 more open (use `muse tasks list`)");
  });

  it("omits the '+N more' line when every open task is imminent", () => {
    const out = formatTasks([
      { dueAt: new Date(2026, 4, 20, 12, 0).toISOString(), id: "t1abc", title: "Lunch prep" }
    ], now, 24);
    expect(out).toContain("Tasks due ≤24h (1):");
    expect(out).not.toContain("more open");
  });

  it("summarises to one line when nothing is due within the window", () => {
    const out = formatTasks([
      { dueAt: new Date(2026, 8, 1, 9, 0).toISOString(), id: "t3ghi", title: "Far future task" },
      { id: "t4jkl", title: "Someday idea" }
    ], now, 24);
    expect(out).toContain("Tasks: 2 open, none due within 24h (use `muse tasks list`)");
    expect(out).not.toContain("Far future task");
  });

  it("none open / not configured states unchanged", () => {
    expect(formatTasks([], now, 24)).toContain("(none open)");
    expect(formatTasks(undefined, now, 24)).toContain("(not configured)");
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

function seedFeedsFile(entries: ReadonlyArray<{ feedId: string; id: string; title: string; publishedAt: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-today-feeds-"));
  const file = join(dir, "feeds.json");
  const byFeed = new Map<string, { id: string; url: string; name: string; entries: unknown[] }>();
  for (const e of entries) {
    if (!byFeed.has(e.feedId)) {
      byFeed.set(e.feedId, { entries: [], id: e.feedId, name: e.feedId, url: `https://example.com/${e.feedId}.xml` });
    }
    byFeed.get(e.feedId)!.entries.push({ id: e.id, link: `https://x.example/${e.id}`, publishedAt: e.publishedAt, summary: "", title: e.title });
  }
  writeFileSync(file, JSON.stringify({ feeds: [...byFeed.values()], version: 1 }), "utf8");
  return file;
}

describe("resolveTodayFeedHeadlines — recent feed headlines merged into the brief", () => {
  const recentIso = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2h ago
  const olderIso = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString(); // 48h ago

  it("returns only entries within the lookahead window, newest-first across feeds", async () => {
    const file = seedFeedsFile([
      { feedId: "tech", id: "t1", title: "Fresh tech", publishedAt: recentIso },
      { feedId: "tech", id: "t0", title: "Stale tech", publishedAt: olderIso },
      { feedId: "news", id: "n1", title: "Fresh news", publishedAt: new Date(Date.now() - 1 * 3_600_000).toISOString() }
    ]);
    const headlines = await resolveTodayFeedHeadlines({ MUSE_FEEDS_FILE: file }, 24);
    const titles = (headlines ?? []).map((h) => h.title);
    expect(titles).toEqual(["Fresh news", "Fresh tech"]); // newest-first; stale excluded
  });

  it("caps the number of headlines", async () => {
    const entries = Array.from({ length: 10 }, (_v, i) => ({
      feedId: "f", id: `e${i.toString()}`, title: `H${i.toString()}`,
      publishedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString()
    }));
    const file = seedFeedsFile(entries);
    const headlines = await resolveTodayFeedHeadlines({ MUSE_FEEDS_FILE: file }, 24, 3);
    expect(headlines).toHaveLength(3);
  });

  it("is fail-soft: a missing store yields undefined (brief omits the section)", async () => {
    const headlines = await resolveTodayFeedHeadlines({ MUSE_FEEDS_FILE: "/no/such/dir/feeds.json" }, 24);
    expect(headlines).toBeUndefined();
  });
});

describe("formatHeadlines", () => {
  it("renders a section and strips terminal-control bytes from a hostile feed title", () => {
    const out = formatHeadlines([
      { feedId: "news", title: `${ESC}[2J${ESC}]0;pwn${BEL}Breaking thing`, publishedAt: "2026-05-24T00:00:00Z" }
    ]);
    expect(hasTerminalControl(out)).toBe(false);
    expect(out).toContain("Breaking thing");
    expect(out).toContain("[news]");
    expect(out).toContain("Headlines (1)");
  });

  it("returns empty string for undefined / empty (brief stays quiet)", () => {
    expect(formatHeadlines(undefined)).toBe("");
    expect(formatHeadlines([])).toBe("");
  });
})

describe("formatTodayConflicts — proactive double-booking warning in the brief", () => {
  it("warns when two timed events overlap", () => {
    const out = formatTodayConflicts([
      { title: "Review", startsAtIso: "2026-05-27T15:00:00.000Z", endsAtIso: "2026-05-27T16:00:00.000Z" },
      { title: "Call", startsAtIso: "2026-05-27T15:30:00.000Z", endsAtIso: "2026-05-27T16:30:00.000Z" }
    ]);
    expect(out).toContain("Double-booked (1)");
    expect(out).toContain('"Review" overlaps "Call"');
    expect(out).toContain("15:30–16:00 UTC");
  });

  it("is silent when events don't overlap, are back-to-back, or lack end times", () => {
    expect(formatTodayConflicts([
      { title: "A", startsAtIso: "2026-05-27T09:00:00.000Z", endsAtIso: "2026-05-27T10:00:00.000Z" },
      { title: "B", startsAtIso: "2026-05-27T10:00:00.000Z", endsAtIso: "2026-05-27T11:00:00.000Z" }
    ])).toBe("");
    // No end times (e.g. a remote briefing) ⇒ no warning, never throws.
    expect(formatTodayConflicts([
      { title: "X", startsAtIso: "2026-05-27T15:00:00.000Z" },
      { title: "Y", startsAtIso: "2026-05-27T15:30:00.000Z" }
    ])).toBe("");
    expect(formatTodayConflicts(undefined)).toBe("");
  });

  it("rides into the full brief output when events conflict", () => {
    const out = formatTodayBrief({
      generatedAt: "2026-05-27T08:00:00.000Z",
      lookaheadHours: 24,
      events: [
        { id: "a", title: "Review", startsAtIso: "2026-05-27T15:00:00.000Z", endsAtIso: "2026-05-27T16:00:00.000Z" },
        { id: "b", title: "Call", startsAtIso: "2026-05-27T15:30:00.000Z", endsAtIso: "2026-05-27T16:30:00.000Z" }
      ]
    }, true);
    expect(out).toContain("Double-booked");
  });
});

describe("muse today — overdue heads-up (leads the digest, mirrors the morning brief)", () => {
  const now = new Date(2026, 4, 20, 9, 0); // 2026-05-20 09:00 local
  const past = (d: number, h = 9) => new Date(2026, 4, d, h, 0).toISOString();
  const future = (d: number, h = 18) => new Date(2026, 4, d, h, 0).toISOString();

  it("selectTodayOverdue picks only past-due items, most-overdue-first, excludes future/undated", () => {
    const overdue = selectTodayOverdue(
      [
        { dueAt: past(18), id: "t1", title: "Pay rent" }, // overdue
        { dueAt: past(15), id: "t2", title: "File taxes" }, // more overdue (earlier due)
        { dueAt: future(20), id: "t3", title: "Call plumber" }, // later today — not overdue
        { id: "t4", title: "Someday idea" } // undated
      ],
      [
        { dueAt: past(19), id: "r1", text: "Take meds" }, // overdue
        { dueAt: future(21), id: "r2", text: "Standup" } // future
      ],
      now
    );
    expect(overdue.tasks.map((t) => t.title)).toEqual(["File taxes", "Pay rent"]); // earliest-due first
    expect(overdue.reminders.map((r) => r.text)).toEqual(["Take meds"]);
  });

  it("selectTodayOverdue is empty when nothing is past due", () => {
    const overdue = selectTodayOverdue([{ dueAt: future(25), id: "t", title: "x" }], [], now);
    expect(overdue.tasks).toEqual([]);
    expect(overdue.reminders).toEqual([]);
  });

  it("formatOverdue renders a led, count-bearing banner — empty when none", () => {
    expect(formatOverdue({ reminders: [], tasks: [] })).toBe("");
    const out = formatOverdue({
      reminders: [{ dueAt: past(19), id: "r1", text: "Take meds" }],
      tasks: [{ dueAt: past(18), id: "t1", title: "Pay rent" }]
    });
    expect(out).toContain("Overdue — past due, still open, act today (2):");
    expect(out).toContain("Pay rent (was due");
    expect(out).toContain("Take meds (was due");
  });

  it("formatTodayBrief LEADS with overdue and does NOT duplicate it in the prospective sections", () => {
    const out = formatTodayBrief(
      {
        generatedAt: new Date(2026, 4, 20, 9, 0).toISOString(),
        lookaheadHours: 24,
        reminders: [{ dueAt: past(19), id: "r1", text: "Take meds" }], // overdue → banner only
        tasks: [
          { dueAt: past(18), id: "t1", title: "Pay rent" }, // overdue → banner only
          { dueAt: future(20), id: "t2", title: "Call plumber" } // future → Tasks section
        ]
      },
      true
    );
    const overduePos = out.indexOf("Overdue — past due");
    const tasksPos = out.indexOf("Tasks due");
    expect(overduePos).toBeGreaterThanOrEqual(0);
    expect(tasksPos).toBeGreaterThan(overduePos); // overdue heads-up leads, before the Tasks section
    expect(out.match(/Pay rent/gu)?.length).toBe(1); // overdue task appears ONCE (banner, not also Tasks)
    expect(out).toContain("Call plumber"); // future task still in the Tasks section
    expect(out.match(/Take meds/gu)?.length).toBe(1); // overdue reminder once (banner)
    expect(out).not.toContain("Reminders ("); // its only reminder was overdue → section omitted, no dup
  });

  it("formatTodayBrief shows no overdue section when nothing is past due", () => {
    const out = formatTodayBrief(
      { generatedAt: new Date(2026, 4, 20, 9, 0).toISOString(), lookaheadHours: 24, tasks: [{ dueAt: future(20), id: "t2", title: "Call plumber" }] },
      true
    );
    expect(out).not.toContain("Overdue — past due");
    expect(out).toContain("Call plumber");
  });
});

describe("formatTodayBrief", () => {
  it("composes header + populated sections into one text block", () => {
    const out = formatTodayBrief({
      generatedAt: "2026-05-25T08:00:00.000Z",
      lookaheadHours: 24,
      weather: "18°C, light rain",
      tasks: [{ id: "t1", title: "pay rent", dueAt: "2026-05-25T18:00:00.000Z" }],
      events: [{ id: "e1", title: "1:1 with Alex", startsAtIso: "2026-05-25T14:00:00.000Z" }]
    }, true);
    expect(out).toContain("Today (");
    expect(out).toContain(", local)");
    expect(out).toContain("18°C, light rain");
    expect(out).toContain("pay rent");
    expect(out).toContain("1:1 with Alex");
  });
  it("an all-empty briefing falls back to onboarding hints", () => {
    const out = formatTodayBrief({ generatedAt: "2026-05-25T08:00:00.000Z", lookaheadHours: 24 }, true);
    expect(out).toContain("Today (");
    expect(out).toMatch(/fresh start/i);
  });
});

describe("formatNextEvent — time-aware 'what's next' lead", () => {
  const now = new Date("2026-05-18T09:35:00.000Z");

  it("highlights the SOONEST future event with a relative countdown", () => {
    const out = formatNextEvent([
      { startsAtIso: "2026-05-18T14:00:00.000Z", title: "Lunch with Sam" },
      { startsAtIso: "2026-05-18T10:00:00.000Z", title: "Standup" }
    ], now);
    expect(out).toBe("⏰ Next: Standup in 25 min\n");
  });

  it("skips events that already started and picks the next upcoming one", () => {
    const out = formatNextEvent([
      { startsAtIso: "2026-05-18T09:00:00.000Z", title: "Earlier meeting" },
      { startsAtIso: "2026-05-18T11:05:00.000Z", title: "Review" }
    ], now);
    expect(out).toBe("⏰ Next: Review in 1h 30m\n");
  });

  it("formats whole-hour and multi-day distances", () => {
    expect(formatNextEvent([{ startsAtIso: "2026-05-18T12:35:00.000Z", title: "X" }], now)).toBe("⏰ Next: X in 3h\n");
    expect(formatNextEvent([{ startsAtIso: "2026-05-20T09:35:00.000Z", title: "Y" }], now)).toBe("⏰ Next: Y in 2 days\n");
  });

  it("is empty with no events, or when none remain upcoming (end of day)", () => {
    expect(formatNextEvent(undefined, now)).toBe("");
    expect(formatNextEvent([], now)).toBe("");
    expect(formatNextEvent([{ startsAtIso: "2026-05-18T08:00:00.000Z", title: "Done" }], now)).toBe("");
  });

  it("strips untrusted terminal escape chars from a third-party event title", () => {
    const out = formatNextEvent([{ startsAtIso: "2026-05-18T10:00:00.000Z", title: "Stand\u001b[31mup" }], now);
    expect(out).not.toContain("\u001b");
    expect(out).toContain("in 25 min");
  });
});
