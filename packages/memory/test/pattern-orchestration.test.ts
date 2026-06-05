import { describe, expect, it } from "vitest";

import {
  detectLapsedPatterns,
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  nextOccurrenceMs,
  predictUpcomingNeeds,
  selectFireablePatterns
} from "../src/index.js";
import type { NoteMtimeSignal, PatternSignals, TaskSignal } from "../src/pattern-signals.js";

function localEdit(absPath: string, pathFamily: string, year: number, month: number, day: number, hour: number, minute: number): NoteMtimeSignal {
  return { absPath, mtimeMs: new Date(year, month - 1, day, hour, minute, 0, 0).getTime(), pathFamily };
}

function localTask(id: string, title: string, year: number, month: number, day: number, hour = 9, minute = 0): TaskSignal {
  return {
    createdAtMs: new Date(year, month - 1, day, hour, minute, 0, 0).getTime(),
    id,
    status: "open",
    title
  };
}

function signalsWithStrongJournalTuesday(): PatternSignals {
  // Five Tuesdays in a row, 21:30 local, journal/. Each at confidence 1.0
  // since every observed Tuesday in the window fired.
  return {
    activityEvents: [],
    capturedAtMs: 0,
    noteEdits: [
      localEdit("/n/journal/a.md", "journal", 2026, 4, 7, 21, 30),
      localEdit("/n/journal/b.md", "journal", 2026, 4, 14, 21, 30),
      localEdit("/n/journal/c.md", "journal", 2026, 4, 21, 21, 30),
      localEdit("/n/journal/d.md", "journal", 2026, 4, 28, 21, 30),
      localEdit("/n/journal/e.md", "journal", 2026, 5, 5, 21, 30)
    ],
    tasks: []
  };
}

describe("nextOccurrenceMs — the next weekday+hour slot at or after now", () => {
  it("returns TODAY when the slot is still ahead today, else the NEXT matching weekday", () => {
    const tueNoon = new Date(2026, 4, 5, 12, 0); // Tue 2026-05-05 12:00 (a Tuesday)
    expect(nextOccurrenceMs("Tue", 21, tueNoon)).toBe(new Date(2026, 4, 5, 21, 0).getTime()); // 9pm today, still ahead
    expect(nextOccurrenceMs("Tue", 9, tueNoon)).toBe(new Date(2026, 4, 12, 9, 0).getTime()); // 9am already passed → next Tuesday
    expect(nextOccurrenceMs("Wed", 9, tueNoon)).toBe(new Date(2026, 4, 6, 9, 0).getTime()); // tomorrow
  });
});

describe("predictUpcomingNeeds — allostatic prediction within a lead window", () => {
  it("predicts a recurring pattern's NEXT occurrence when it lands inside the window, soonest first", () => {
    const wed = new Date(2026, 4, 6, 12, 0); // the Wednesday after the 5 journal-Tuesdays
    const predicted = predictUpcomingNeeds(wed, signalsWithStrongJournalTuesday(), { leadWindowMs: 7 * 86_400_000, minConfidence: 0.5 });
    expect(predicted).toHaveLength(1);
    expect(predicted[0]!.kind).toBe("time-of-day-action");
    expect(predicted[0]!.predictedAtMs).toBe(new Date(2026, 4, 12, 21, 0).getTime()); // next Tuesday 21:00 (hour-band 21-24)
  });

  it("does NOT predict a pattern whose next occurrence is beyond the lead window", () => {
    const wed = new Date(2026, 4, 6, 12, 0); // next Tuesday 21:00 is ~6 days away
    expect(predictUpcomingNeeds(wed, signalsWithStrongJournalTuesday(), { leadWindowMs: 24 * 3_600_000, minConfidence: 0.5 })).toEqual([]);
  });

  it("drops predictions below the confidence floor and returns [] on empty signals", () => {
    const wed = new Date(2026, 4, 6, 12, 0);
    expect(predictUpcomingNeeds(wed, signalsWithStrongJournalTuesday(), { leadWindowMs: 7 * 86_400_000, minConfidence: 0.99999 })[0]).toBeDefined(); // conf 1.0 survives
    expect(predictUpcomingNeeds(wed, { activityEvents: [], capturedAtMs: 0, noteEdits: [], tasks: [] })).toEqual([]);
  });
});

describe("detectLapsedPatterns — CUSUM-style sustained-miss change-point", () => {
  it("flags an established weekly habit whose last occurrence is >= minCyclesMissed cycles ago", () => {
    // last journal-Tuesday was 2026-05-05; now is ~4.5 weeks later
    const lateJune = new Date(2026, 5, 5, 12, 0);
    const lapsed = detectLapsedPatterns(lateJune, signalsWithStrongJournalTuesday(), { minConfidence: 0.5, minCyclesMissed: 2 });
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]!.cyclesMissed).toBeGreaterThanOrEqual(4);
    expect(lapsed[0]!.lastSeenMs).toBe(new Date(2026, 4, 5, 21, 30).getTime()); // the most recent Tuesday edit
  });

  it("does NOT flag a habit whose last occurrence is within minCyclesMissed cycles (still on track)", () => {
    const oneWeekLater = new Date(2026, 4, 12, 12, 0); // 1 week after the last Tuesday
    expect(detectLapsedPatterns(oneWeekLater, signalsWithStrongJournalTuesday(), { minConfidence: 0.5, minCyclesMissed: 2 })).toEqual([]);
  });

  it("returns [] on empty signals and respects a higher missed-cycles threshold", () => {
    const lateJune = new Date(2026, 5, 5, 12, 0);
    expect(detectLapsedPatterns(lateJune, { activityEvents: [], capturedAtMs: 0, noteEdits: [], tasks: [] })).toEqual([]);
    expect(detectLapsedPatterns(lateJune, signalsWithStrongJournalTuesday(), { minCyclesMissed: 99 })).toEqual([]);
  });
});

describe("selectFireablePatterns", () => {
  it("returns [] when no signals are present", () => {
    const empty: PatternSignals = { activityEvents: [], capturedAtMs: 0, noteEdits: [], tasks: [] };
    expect(selectFireablePatterns(new Date(), empty, [])).toEqual([]);
  });

  it("fires in-slot patterns above the proactive confidence floor (default 0.7), skips cool-down ones", () => {
    const now = new Date(2026, 4, 12, 21, 30); // Tuesday May 12 2026 21:30
    const signals = signalsWithStrongJournalTuesday();

    // No cooldown records → should fire.
    const fireable = selectFireablePatterns(now, signals, []);
    expect(fireable).toHaveLength(1);
    const firedId = fireable[0]!.id;

    // Now claim it was fired 1 hour ago → cooldown 24h blocks it.
    const recent = [{ firedAtMs: now.getTime() - 60 * 60_000, patternId: firedId }];
    expect(selectFireablePatterns(now, signals, recent)).toHaveLength(0);

    // Same pattern, fired 25 hours ago → past cooldown.
    const stale = [{ firedAtMs: now.getTime() - 25 * 60 * 60_000, patternId: firedId }];
    expect(selectFireablePatterns(now, signals, stale)).toHaveLength(1);
  });

  it("respects the minConfidence override (raising it can suppress a 1.0-confidence match)", () => {
    const now = new Date(2026, 4, 12, 21, 30);
    const signals = signalsWithStrongJournalTuesday();
    // Strict override above 1.0 — nothing passes.
    expect(selectFireablePatterns(now, signals, [], { minConfidence: 1.01 })).toHaveLength(0);
  });

  it("finite-guards non-finite knobs (a typo'd env value becomes NaN — must not silently disable or spam)", () => {
    const now = new Date(2026, 4, 12, 21, 30);
    const signals = signalsWithStrongJournalTuesday();

    // maxPerTick: NaN must fall to the default cap, NOT `slice(0, NaN)` → [].
    expect(selectFireablePatterns(now, signals, [], { maxPerTick: Number.NaN })).toHaveLength(1);

    // cooldownMs: NaN must fall to the 24h default so a pattern fired 1h
    // ago stays on cooldown — NOT `nowMs - lastFired < NaN` (false) → re-fire.
    const firedId = selectFireablePatterns(now, signals, [])[0]!.id;
    const recent = [{ firedAtMs: now.getTime() - 60 * 60_000, patternId: firedId }];
    expect(selectFireablePatterns(now, signals, recent, { cooldownMs: Number.NaN })).toHaveLength(0);
  });

  it("excludes patterns outside the current weekday + band (currentSlotOnly is enforced)", () => {
    const signals = signalsWithStrongJournalTuesday();
    // "now" = Wednesday 21:30 — none of the Tuesday slots match.
    const now = new Date(2026, 4, 13, 21, 30);
    expect(selectFireablePatterns(now, signals, [])).toHaveLength(0);

    // Same Tuesday data but "now" is Tuesday MORNING (9:00) — wrong band.
    const morning = new Date(2026, 4, 12, 9, 0);
    expect(selectFireablePatterns(morning, signals, [])).toHaveLength(0);
  });

  it("caps the output at maxPerTick, keeping the highest-confidence matches", () => {
    // Build two independent strong clusters in the same in-slot bucket
    // for the same Tuesday 21-24 band but different path families.
    const now = new Date(2026, 4, 12, 21, 30);
    const signals: PatternSignals = {
      activityEvents: [],
      capturedAtMs: 0,
      noteEdits: [
        localEdit("/n/journal/a.md", "journal", 2026, 4, 7, 21, 30),
        localEdit("/n/journal/b.md", "journal", 2026, 4, 14, 21, 30),
        localEdit("/n/journal/c.md", "journal", 2026, 4, 21, 21, 30),
        localEdit("/n/reading/a.md", "reading", 2026, 4, 7, 21, 45),
        localEdit("/n/reading/b.md", "reading", 2026, 4, 14, 21, 45),
        localEdit("/n/reading/c.md", "reading", 2026, 4, 21, 21, 45),
        localEdit("/n/diary/a.md", "diary", 2026, 4, 7, 22, 0),
        localEdit("/n/diary/b.md", "diary", 2026, 4, 14, 22, 0),
        localEdit("/n/diary/c.md", "diary", 2026, 4, 21, 22, 0)
      ],
      tasks: []
    };
    const capped = selectFireablePatterns(now, signals, [], { maxPerTick: 2 });
    expect(capped).toHaveLength(2);
    // Sort is by confidence desc — all three should tie at 1.0; the
    // cap just keeps the first two regardless of which.
    expect(capped.every((m) => m.confidence >= 0.7)).toBe(true);
  });

  it("combines time-of-day + weekly-task into one fireable list, both gated by cooldown", () => {
    const now = new Date(2026, 4, 4, 9, 0); // Monday May 4 2026, morning
    const signals: PatternSignals = {
      activityEvents: [],
      capturedAtMs: 0,
      // Tuesday-evening journals — but it's currently Monday, so currentSlotOnly drops it.
      noteEdits: [
        localEdit("/n/journal/a.md", "journal", 2026, 4, 14, 21, 30),
        localEdit("/n/journal/b.md", "journal", 2026, 4, 21, 21, 30),
        localEdit("/n/journal/c.md", "journal", 2026, 4, 28, 21, 30)
      ],
      // Monday-morning standup notes for 4 different Mondays.
      tasks: [
        localTask("t0", "Standup notes", 2026, 4, 13, 9, 0),
        localTask("t1", "Standup notes", 2026, 4, 20, 9, 0),
        localTask("t2", "Standup notes", 2026, 4, 27, 9, 0),
        localTask("t3", "Standup notes", 2026, 5, 4, 9, 0) // already this week — missing=false
      ]
    };
    // currentSlotOnly true for both detectors. The Tuesday journal can't
    // fire on Monday (slot mismatch). The Monday standup-notes IS in
    // slot but `missingThisWeek=false` (a task already created this week)
    // → also filtered out.
    expect(selectFireablePatterns(now, signals, [])).toHaveLength(0);

    // Drop the current-week task — same orchestrator now fires the weekly.
    const signalsMissing: PatternSignals = {
      ...signals,
      tasks: signals.tasks.slice(0, 3)
    };
    const fireable = selectFireablePatterns(now, signalsMissing, []);
    expect(fireable.map((m) => m.category)).toEqual(["weekly-task"]);
    if (fireable[0]!.category === "weekly-task") {
      expect(fireable[0]!.missingThisWeek).toBe(true);
    }
  });

  it("sanity: the detectors and the orchestrator agree on cluster ids (caller can match cooldown by id)", () => {
    const now = new Date(2026, 4, 12, 21, 30);
    const signals = signalsWithStrongJournalTuesday();
    const direct = detectTimeOfDayPatterns(now, signals, { currentSlotOnly: true });
    const fireable = selectFireablePatterns(now, signals, []);
    expect(fireable[0]!.id).toBe(direct[0]!.id);

    // Same id check for weekly-task path.
    const weeklySignals: PatternSignals = {
      activityEvents: [],
      capturedAtMs: 0,
      noteEdits: [],
      tasks: [
        localTask("t1", "Standup notes", 2026, 4, 20, 9, 0),
        localTask("t2", "Standup notes", 2026, 4, 27, 9, 0),
        localTask("t3", "Standup notes", 2026, 5, 4, 9, 0)
      ]
    };
    const weekly = detectWeeklyTaskPatterns(new Date(2026, 4, 11, 9, 0), weeklySignals, { currentSlotOnly: true });
    const orch = selectFireablePatterns(new Date(2026, 4, 11, 9, 0), weeklySignals, []);
    expect(orch[0]!.id).toBe(weekly[0]!.id);
  });
});
