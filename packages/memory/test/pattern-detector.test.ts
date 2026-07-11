import { describe, expect, it } from "vitest";

import { detectTimeOfDayPatterns, detectWeeklyTaskPatterns } from "../src/pattern-detector.js";
import type { NoteMtimeSignal, PatternSignals, TaskSignal } from "../src/pattern-signals.js";

function makeSignals(noteEdits: readonly NoteMtimeSignal[], tasks: readonly TaskSignal[] = []): PatternSignals {
  return {
    activityEvents: [],
    capturedAtMs: Date.parse("2026-05-13T21:00:00Z"),
    noteEdits,
    tasks
  };
}

function localTask(id: string, title: string, year: number, month: number, day: number, hour = 9, minute = 0): TaskSignal {
  return {
    createdAtMs: new Date(year, month - 1, day, hour, minute, 0, 0).getTime(),
    id,
    status: "open",
    title
  };
}

// Build an mtime that lands on a specific weekday + hour in local time.
// Tests assert against the weekday derived from the SAME local clock —
// not the UTC weekday — so seed values pinned to local construction
// stay stable across CI tzs.
function localEdit(absPath: string, pathFamily: string, year: number, month: number, day: number, hour: number, minute: number): NoteMtimeSignal {
  const d = new Date(year, month - 1, day, hour, minute, 0, 0);
  return { absPath, mtimeMs: d.getTime(), pathFamily };
}

describe("detectTimeOfDayPatterns", () => {
  it("returns [] when no note edits exist", () => {
    expect(detectTimeOfDayPatterns(new Date(), makeSignals([]))).toEqual([]);
  });

  it("ignores buckets that don't meet the matches + distinct-days floor", () => {
    // 4 edits on the same Tuesday evening → matches=4 but distinctDays=1 (below default 2)
    const signals = makeSignals([
      localEdit("/n/journal/a.md", "journal", 2026, 5, 12, 21, 10),
      localEdit("/n/journal/b.md", "journal", 2026, 5, 12, 21, 20),
      localEdit("/n/journal/c.md", "journal", 2026, 5, 12, 21, 30),
      localEdit("/n/journal/d.md", "journal", 2026, 5, 12, 21, 40)
    ]);
    expect(detectTimeOfDayPatterns(new Date(2026, 4, 13, 21, 0), signals)).toEqual([]);
  });

  it("fires on a 3-edit cluster spanning 3 Tuesdays in the same 21-24 band", () => {
    const signals = makeSignals([
      localEdit("/n/journal/a.md", "journal", 2026, 4, 14, 21, 10), // Tue Apr 14 2026 - actually Tue check
      localEdit("/n/journal/b.md", "journal", 2026, 4, 21, 21, 20),
      localEdit("/n/journal/c.md", "journal", 2026, 4, 28, 21, 30),
      // Noise on different days/bands — shouldn't merge
      localEdit("/n/meetings/x.md", "meetings", 2026, 4, 15, 9, 0)
    ]);
    const matches = detectTimeOfDayPatterns(new Date(2026, 4, 13, 21, 0), signals);
    const journalMatch = matches.find((m) => m.bucket.pathFamily === "journal");
    expect(journalMatch).toBeDefined();
    expect(journalMatch!.bucket).toMatchObject({
      distinctDays: 3,
      hourBand: "21-24",
      matches: 3,
      pathFamily: "journal"
    });
    expect(journalMatch!.confidence).toBeGreaterThan(0.4);
    expect(journalMatch!.suggestion).toContain("journal notes");
    expect(journalMatch!.suggestion).toContain("21-24");
    expect(journalMatch!.id).toMatch(/^[a-f0-9]{12}$/u);
  });

  it("suggestion's rationale clause echoes the bucket's own counts verbatim (why-it-fired, no fabrication)", () => {
    const signals = makeSignals([
      localEdit("/n/journal/a.md", "journal", 2026, 4, 14, 21, 10),
      localEdit("/n/journal/b.md", "journal", 2026, 4, 21, 21, 20),
      localEdit("/n/journal/c.md", "journal", 2026, 4, 28, 21, 30),
      localEdit("/n/journal/d.md", "journal", 2026, 5, 5, 21, 40)
    ]);
    const matches = detectTimeOfDayPatterns(new Date(2026, 4, 13, 21, 0), signals);
    const match = matches[0]!;
    // The clause's numbers MUST equal the bucket's own matches/distinctDays —
    // never a separately-computed or model-invented figure.
    expect(match.suggestion).toContain(
      `(${match.bucket.matches.toString()} edits across ${match.bucket.distinctDays.toString()} days)`
    );
  });

  it("uses a stable sha256-derived id keyed off weekday + band + family", () => {
    const a = makeSignals([
      localEdit("/n/journal/a.md", "journal", 2026, 4, 14, 21, 10),
      localEdit("/n/journal/b.md", "journal", 2026, 4, 21, 21, 20),
      localEdit("/n/journal/c.md", "journal", 2026, 4, 28, 21, 30)
    ]);
    const b = makeSignals([
      localEdit("/elsewhere/x.md", "journal", 2026, 4, 14, 21, 50),
      localEdit("/elsewhere/y.md", "journal", 2026, 4, 21, 21, 55),
      localEdit("/elsewhere/z.md", "journal", 2026, 4, 28, 21, 58)
    ]);
    const idA = detectTimeOfDayPatterns(new Date(2026, 4, 13, 21, 0), a)[0]!.id;
    const idB = detectTimeOfDayPatterns(new Date(2026, 4, 13, 21, 0), b)[0]!.id;
    // Different paths but the same weekday/band/family → same id (the
    // point of the stable hash is dedupe across runs).
    expect(idA).toBe(idB);
  });

  it("currentSlotOnly filters to the now-active weekday + hour-band", () => {
    const signals = makeSignals([
      // Tuesday evenings — slot A
      localEdit("/n/journal/a.md", "journal", 2026, 4, 14, 21, 10),
      localEdit("/n/journal/b.md", "journal", 2026, 4, 21, 21, 20),
      localEdit("/n/journal/c.md", "journal", 2026, 4, 28, 21, 30),
      // Monday mornings — slot B
      localEdit("/n/standup/a.md", "standup", 2026, 4, 13, 9, 10),
      localEdit("/n/standup/b.md", "standup", 2026, 4, 20, 9, 20),
      localEdit("/n/standup/c.md", "standup", 2026, 4, 27, 9, 30)
    ]);
    // "Now" is Tuesday 22:00 local — should match Tuesday 21-24 only.
    const matches = detectTimeOfDayPatterns(
      new Date(2026, 4, 5, 22, 0), // Tuesday May 5 2026
      signals,
      { currentSlotOnly: true }
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.bucket).toMatchObject({ hourBand: "21-24", pathFamily: "journal", weekday: "Tue" });
  });

  it("folds path-family='' (root-level notes) into a (root) bucket label", () => {
    const signals = makeSignals([
      localEdit("/n/a.md", "", 2026, 4, 14, 7, 10),
      localEdit("/n/b.md", "", 2026, 4, 21, 7, 20),
      localEdit("/n/c.md", "", 2026, 4, 28, 7, 30)
    ]);
    const matches = detectTimeOfDayPatterns(new Date(2026, 4, 13, 7, 0), signals);
    expect(matches[0]!.bucket.pathFamily).toBe("(root)");
    expect(matches[0]!.suggestion).toContain("root-level notes");
  });

  it("sorts the output by confidence desc, then matches desc", () => {
    const signals = makeSignals([
      // Cluster A — 3 edits across 3 weeks, confidence 1.0
      localEdit("/a/1.md", "alpha", 2026, 4, 14, 9, 10),
      localEdit("/a/2.md", "alpha", 2026, 4, 21, 9, 20),
      localEdit("/a/3.md", "alpha", 2026, 4, 28, 9, 30),
      // Cluster B — 5 edits but spread across only 2 distinct Tuesdays out of an observed 3-week span
      // confidence = 2/3 ≈ 0.66
      localEdit("/b/1.md", "beta", 2026, 4, 14, 21, 10),
      localEdit("/b/2.md", "beta", 2026, 4, 14, 21, 20),
      localEdit("/b/3.md", "beta", 2026, 4, 21, 21, 30),
      localEdit("/b/4.md", "beta", 2026, 4, 21, 21, 40),
      localEdit("/b/5.md", "beta", 2026, 4, 21, 21, 50)
    ]);
    const matches = detectTimeOfDayPatterns(new Date(2026, 4, 13, 21, 0), signals);
    expect(matches[0]!.bucket.pathFamily).toBe("alpha");
    expect(matches[0]!.confidence).toBeGreaterThan(matches[1]!.confidence);
  });
});

describe("detectWeeklyTaskPatterns", () => {
  it("returns [] when no tasks exist", () => {
    expect(detectWeeklyTaskPatterns(new Date(), makeSignals([], []))).toEqual([]);
  });

  it("ignores clusters that don't meet matches + distinctWeeks floors", () => {
    // 3 identical-title tasks but all created on the SAME Monday →
    // matches=3, distinctWeeks=1 (below default 2). Drops out.
    const signals = makeSignals([], [
      localTask("t1", "Daily standup", 2026, 5, 4, 9),
      localTask("t2", "Daily standup", 2026, 5, 4, 9),
      localTask("t3", "Daily standup", 2026, 5, 4, 9)
    ]);
    expect(detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), signals)).toEqual([]);
  });

  it("fires on 3 same-title tasks across 3 Mondays, raising missingThisWeek when none exists yet this week", () => {
    // Mondays: Apr 27, May 4, May 11 in 2026.
    // "now" = Monday May 11 09:00 LOCAL — same weekday but ONE matching task already in this week.
    // No "Standup notes" task this week → missingThisWeek=true.
    const signals = makeSignals([], [
      localTask("t1", "Standup notes", 2026, 4, 27, 9, 5),
      localTask("t2", "Standup notes", 2026, 5, 4, 9, 5),
      localTask("t3", "Standup notes", 2026, 5, 11, 9, 5) // already this week → missing=false
    ]);
    const now = new Date(2026, 4, 11, 9, 0); // Monday May 11
    const matches = detectWeeklyTaskPatterns(now, signals);
    expect(matches).toHaveLength(1);
    const match = matches[0]!;
    expect(match.category).toBe("weekly-task");
    expect(match.bucket.weekday).toBe("Mon");
    expect(match.bucket.matches).toBe(3);
    expect(match.bucket.distinctWeeks).toBe(3);
    expect(match.missingThisWeek).toBe(false);
    // The rationale clause's numbers MUST equal the bucket's own
    // matches/distinctWeeks — never a separately-computed figure.
    expect(match.suggestion).toContain(
      `(${match.bucket.matches.toString()} times across ${match.bucket.distinctWeeks.toString()} weeks)`
    );

    // Now drop the in-week entry — should flip missingThisWeek=true.
    const signalsMissing = makeSignals([], [
      localTask("t1", "Standup notes", 2026, 4, 20, 9, 5),
      localTask("t2", "Standup notes", 2026, 4, 27, 9, 5),
      localTask("t3", "Standup notes", 2026, 5, 4, 9, 5)
    ]);
    const matchesMissing = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), signalsMissing);
    expect(matchesMissing[0]!.missingThisWeek).toBe(true);
  });

  it("normaliser is conservative — collapses whitespace + lowercases + strips trailing punctuation, but NOT cross-token fuzz", () => {
    // These three should cluster as one (case + whitespace + trailing dot).
    const signals = makeSignals([], [
      localTask("t1", "Daily Standup", 2026, 4, 20, 9, 0),
      localTask("t2", "daily  standup.", 2026, 4, 27, 9, 0),
      localTask("t3", "DAILY STANDUP", 2026, 5, 4, 9, 0),
      // These two should NOT join the cluster (extra word).
      localTask("t4", "Daily standup notes", 2026, 4, 21, 9, 0),
      localTask("t5", "Daily standup notes", 2026, 4, 28, 9, 0)
    ]);
    const matches = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), signals);
    const cluster = matches.find((m) => m.bucket.titleKey === "daily standup");
    expect(cluster).toBeDefined();
    expect(cluster!.bucket.matches).toBe(3);
    expect(cluster!.relatedTitles).toEqual(["Daily Standup", "daily  standup.", "DAILY STANDUP"]);
    // The "notes" variant has only 2 matches — below the default
    // minMatches floor, so it's correctly filtered out. Drop the
    // matches threshold to verify it would have clustered separately.
    const matchesLowFloor = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), signals, { minMatches: 2 });
    const noted = matchesLowFloor.find((m) => m.bucket.titleKey === "daily standup notes");
    expect(noted).toBeDefined();
    expect(noted!.bucket.matches).toBe(2);
  });

  it("currentSlotOnly filters to clusters whose weekday matches now AND missingThisWeek is true", () => {
    // Two clusters: Monday standup (3 weeks of data, missing this week)
    // and Friday retro (3 weeks of data, but it's currently Monday — wrong weekday).
    const signals = makeSignals([], [
      localTask("t1", "Standup", 2026, 4, 20, 9, 0),
      localTask("t2", "Standup", 2026, 4, 27, 9, 0),
      localTask("t3", "Standup", 2026, 5, 4, 9, 0),
      localTask("t4", "Retro", 2026, 4, 24, 16, 0),
      localTask("t5", "Retro", 2026, 5, 1, 16, 0),
      localTask("t6", "Retro", 2026, 5, 8, 16, 0)
    ]);
    const matches = detectWeeklyTaskPatterns(
      new Date(2026, 4, 11, 9, 0), // Monday May 11
      signals,
      { currentSlotOnly: true }
    );
    expect(matches.map((m) => m.bucket.titleKey)).toEqual(["standup"]);
    expect(matches[0]!.missingThisWeek).toBe(true);
  });

  it("stable id is sha256-derived from `weekly-task:weekday:titleKey`", () => {
    const signals = makeSignals([], [
      localTask("t1", "Standup notes", 2026, 4, 20, 9, 0),
      localTask("t2", "Standup notes", 2026, 4, 27, 9, 0),
      localTask("t3", "Standup notes", 2026, 5, 4, 9, 0)
    ]);
    const first = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), signals)[0]!;
    expect(first.id).toMatch(/^[a-f0-9]{12}$/u);
    // Different task ids but same weekday + normalised title → same cluster id.
    const altered = makeSignals([], [
      localTask("xA", "STANDUP NOTES.", 2026, 4, 20, 9, 0),
      localTask("xB", "standup notes", 2026, 4, 27, 9, 0),
      localTask("xC", "Standup  Notes", 2026, 5, 4, 9, 0)
    ]);
    const second = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), altered)[0]!;
    expect(second.id).toBe(first.id);
  });

  it("drops blank-title tasks instead of crashing on an empty titleKey", () => {
    const signals = makeSignals([], [
      localTask("t1", "   ", 2026, 4, 20, 9, 0),
      localTask("t2", "Real one", 2026, 4, 20, 9, 0),
      localTask("t3", "Real one", 2026, 4, 27, 9, 0),
      localTask("t4", "Real one", 2026, 5, 4, 9, 0)
    ]);
    const matches = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), signals);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.bucket.titleKey).toBe("real one");
  });
});
