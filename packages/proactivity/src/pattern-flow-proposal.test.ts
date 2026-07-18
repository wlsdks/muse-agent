import { describe, expect, it } from "vitest";

import { proposeFlowsFromPatterns } from "./pattern-flow-proposal.js";

import type { PatternMatch, TimeOfDayMatch, WeeklyTaskMatch } from "@muse/memory";

function timeOfDay(overrides: Partial<TimeOfDayMatch> = {}): TimeOfDayMatch {
  return {
    bucket: {
      distinctDays: 3,
      hourBand: "9-12",
      matches: 3,
      pathFamily: "journal",
      weekday: "Mon"
    },
    category: "time-of-day-action",
    confidence: 0.9,
    id: "tod-1",
    relatedPaths: ["/notes/journal/a.md", "/notes/journal/b.md", "/notes/journal/c.md", "/notes/journal/d.md"],
    suggestion: "You usually edit journal notes around 9-12 on Mons (3 edits across 3 days). Want me to surface the most recent one?",
    ...overrides
  };
}

function weeklyTask(overrides: Partial<WeeklyTaskMatch> = {}): WeeklyTaskMatch {
  return {
    bucket: {
      distinctWeeks: 3,
      matches: 3,
      titleKey: "weekly report",
      titleTemplate: "Weekly report",
      weekday: "Fri"
    },
    category: "weekly-task",
    confidence: 0.85,
    id: "weekly-1",
    missingThisWeek: true,
    relatedTitles: ["Weekly report", "Weekly report", "Weekly report"],
    suggestion: '"Weekly report" — You usually create this on Fris but haven\'t this week — want me to add it? (3 times across 3 weeks).',
    ...overrides
  };
}

describe("proposeFlowsFromPatterns — evidence gate (fail-close)", () => {
  it("proposes a time-of-day match that clears both bars", () => {
    const [proposal] = proposeFlowsFromPatterns([timeOfDay()], []);
    expect(proposal).toBeDefined();
    expect(proposal!.id).toBe("tod-1");
    expect(proposal!.category).toBe("time-of-day-action");
  });

  it("drops a match below the confidence floor (default 0.7)", () => {
    const proposals = proposeFlowsFromPatterns([timeOfDay({ confidence: 0.69 })], []);
    expect(proposals).toHaveLength(0);
  });

  it("keeps a match exactly AT the confidence floor", () => {
    const proposals = proposeFlowsFromPatterns([timeOfDay({ confidence: 0.7 })], []);
    expect(proposals).toHaveLength(1);
  });

  it("drops a match below the observation-count floor (default 3), even at high confidence", () => {
    const proposals = proposeFlowsFromPatterns(
      [timeOfDay({ bucket: { ...timeOfDay().bucket, matches: 2 }, confidence: 0.99 })],
      []
    );
    expect(proposals).toHaveLength(0);
  });

  it("keeps a match exactly AT the observation-count floor", () => {
    const proposals = proposeFlowsFromPatterns([timeOfDay({ bucket: { ...timeOfDay().bucket, matches: 3 } })], []);
    expect(proposals).toHaveLength(1);
  });

  it("filters out a rejected id — never re-proposed", () => {
    const proposals = proposeFlowsFromPatterns([timeOfDay()], ["tod-1"]);
    expect(proposals).toHaveLength(0);
  });

  it("a rejected id does not affect an UNrelated match", () => {
    const proposals = proposeFlowsFromPatterns([timeOfDay(), weeklyTask()], ["tod-1"]);
    expect(proposals.map((p) => p.id)).toEqual(["weekly-1"]);
  });

  it("caps at 2 proposals even with 3+ eligible matches, keeping the highest-confidence ones", () => {
    const matches: readonly PatternMatch[] = [
      timeOfDay({ confidence: 0.8, id: "a" }),
      timeOfDay({ bucket: { ...timeOfDay().bucket, weekday: "Tue" }, confidence: 0.95, id: "b" }),
      weeklyTask({ confidence: 0.9, id: "c" })
    ];
    const proposals = proposeFlowsFromPatterns(matches, []);
    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("respects an explicit maxProposals override", () => {
    const matches: readonly PatternMatch[] = [
      timeOfDay({ confidence: 0.8, id: "a" }),
      weeklyTask({ confidence: 0.9, id: "c" })
    ];
    const proposals = proposeFlowsFromPatterns(matches, [], { maxProposals: 1 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.id).toBe("c");
  });

  it("respects an explicit minConfidence / minObservationCount override", () => {
    const weak = timeOfDay({ bucket: { ...timeOfDay().bucket, matches: 1 }, confidence: 0.5 });
    expect(proposeFlowsFromPatterns([weak], [], { minConfidence: 0.4, minObservationCount: 1 })).toHaveLength(1);
    expect(proposeFlowsFromPatterns([weak], [])).toHaveLength(0);
  });

  it("returns an empty array for an empty input", () => {
    expect(proposeFlowsFromPatterns([], [])).toEqual([]);
  });
});

describe("proposeFlowsFromPatterns — cron mapping (exact per weekday/hourBand)", () => {
  it.each([
    ["Sun", "0-3", "0 0 * * 0"],
    ["Mon", "9-12", "0 9 * * 1"],
    ["Tue", "12-15", "0 12 * * 2"],
    ["Wed", "15-18", "0 15 * * 3"],
    ["Thu", "18-21", "0 18 * * 4"],
    ["Fri", "21-24", "0 21 * * 5"],
    ["Sat", "6-9", "0 6 * * 6"]
  ] as const)("weekday=%s hourBand=%s -> %s", (weekday, hourBand, expected) => {
    const [proposal] = proposeFlowsFromPatterns(
      [timeOfDay({ bucket: { ...timeOfDay().bucket, hourBand, weekday } })],
      []
    );
    expect(proposal!.cronExpression).toBe(expected);
  });

  it("weekly-task matches anchor to a default 09:00 slot (no hour signal in the detector)", () => {
    const [proposal] = proposeFlowsFromPatterns([weeklyTask({ bucket: { ...weeklyTask().bucket, weekday: "Wed" } })], []);
    expect(proposal!.cronExpression).toBe("0 9 * * 3");
  });
});

describe("proposeFlowsFromPatterns — receipt + suggestionText + examples cap", () => {
  it("builds a Korean suggestion line wrapping the raw detector suggestion verbatim", () => {
    const match = timeOfDay();
    const [proposal] = proposeFlowsFromPatterns([match], []);
    expect(proposal!.suggestionText).toBe(`매주 월요일 오전 9시에 ${match.suggestion}`);
  });

  it("caps examples at 3 by default even when the detector supplies more", () => {
    const [proposal] = proposeFlowsFromPatterns([timeOfDay()], []);
    expect(proposal!.receipt.examples).toEqual(["/notes/journal/a.md", "/notes/journal/b.md", "/notes/journal/c.md"]);
  });

  it("respects an explicit maxExamples override", () => {
    const [proposal] = proposeFlowsFromPatterns([timeOfDay()], [], { maxExamples: 1 });
    expect(proposal!.receipt.examples).toEqual(["/notes/journal/a.md"]);
  });

  it("uses relatedTitles (not relatedPaths) as examples for a weekly-task match", () => {
    const [proposal] = proposeFlowsFromPatterns([weeklyTask()], []);
    expect(proposal!.receipt.examples).toEqual(["Weekly report", "Weekly report", "Weekly report"]);
  });

  it("carries observationCount/distinctCount/distinctUnit/confidence straight from the match's own bucket", () => {
    const [proposal] = proposeFlowsFromPatterns([weeklyTask()], []);
    expect(proposal!.receipt).toEqual({
      confidence: 0.85,
      distinctCount: 3,
      distinctUnit: "weeks",
      examples: ["Weekly report", "Weekly report", "Weekly report"],
      observationCount: 3
    });
  });

  it("time-of-day receipt uses distinctUnit 'days'", () => {
    const [proposal] = proposeFlowsFromPatterns([timeOfDay()], []);
    expect(proposal!.receipt.distinctUnit).toBe("days");
    expect(proposal!.receipt.distinctCount).toBe(3);
  });
});
