import { describe, expect, it } from "vitest";

import {
  checkObjectiveMet,
  resolveObjectiveEvidence,
  type EvidenceQuery,
  type ObjectiveEvidenceDeps
} from "../src/objective-evidence.js";

const NOW = new Date("2026-07-11T12:00:00.000Z");

describe("resolveObjectiveEvidence — enum-switch fetch via injected readers", () => {
  it("routes 'tasks' to readTasks only, ignoring the other readers", async () => {
    const deps: ObjectiveEvidenceDeps = {
      readReminders: async () => [{ text: "should not be called" }],
      readTasks: async () => [{ createdAt: "2026-07-10T00:00:00Z", title: "log the workout" }]
    };
    const records = await resolveObjectiveEvidence({ keywords: ["workout"], store: "tasks" }, deps);
    expect(records).toEqual([{ source: "task:log the workout", text: "log the workout", whenIso: "2026-07-10T00:00:00Z" }]);
  });

  it("routes 'reminders' to readReminders only", async () => {
    const deps: ObjectiveEvidenceDeps = { readReminders: async () => [{ dueAt: "2026-07-10T00:00:00Z", text: "call mom" }] };
    const records = await resolveObjectiveEvidence({ keywords: ["mom"], store: "reminders" }, deps);
    expect(records).toEqual([{ source: "reminder:call mom", text: "call mom", whenIso: "2026-07-10T00:00:00Z" }]);
  });

  it("routes 'calendar' to listCalendarEvents, requesting a window around now", async () => {
    let requestedRange: { from: Date; to: Date } | undefined;
    const deps: ObjectiveEvidenceDeps = {
      listCalendarEvents: async (range) => {
        requestedRange = range;
        return [{ startsAt: new Date("2026-07-12T09:00:00Z"), title: "standup" }];
      },
      now: () => NOW
    };
    const records = await resolveObjectiveEvidence({ keywords: ["standup"], store: "calendar", windowDays: 7 }, deps);
    expect(records).toEqual([{ source: "calendar:standup", text: "standup", whenIso: "2026-07-12T09:00:00.000Z" }]);
    expect(requestedRange!.from.getTime()).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(requestedRange!.to.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
  });

  it("routes 'notes' to searchNotes, forwarding the keywords", async () => {
    let forwarded: readonly string[] | undefined;
    const deps: ObjectiveEvidenceDeps = {
      searchNotes: async (keywords) => {
        forwarded = keywords;
        return [{ id: "n1", snippet: "did the workout today", title: "log" }];
      }
    };
    const records = await resolveObjectiveEvidence({ keywords: ["workout"], store: "notes" }, deps);
    expect(forwarded).toEqual(["workout"]);
    expect(records).toEqual([{ source: "note:log", text: "log did the workout today", whenIso: undefined }]);
  });

  it("routes 'actionLog' to queryActionLog only", async () => {
    const deps: ObjectiveEvidenceDeps = {
      queryActionLog: async () => [{ what: "objective met", when: "2026-07-10T00:00:00Z", why: "ship the release" }]
    };
    const records = await resolveObjectiveEvidence({ keywords: ["ship"], store: "actionLog" }, deps);
    expect(records).toEqual([{ source: "actionLog:objective met", text: "objective met ship the release", whenIso: "2026-07-10T00:00:00Z" }]);
  });

  it("a store whose reader wasn't injected resolves to no evidence (fail-closed), never throws", async () => {
    await expect(resolveObjectiveEvidence({ keywords: [], store: "tasks" }, {})).resolves.toEqual([]);
    await expect(resolveObjectiveEvidence({ keywords: [], store: "calendar" }, {})).resolves.toEqual([]);
    await expect(resolveObjectiveEvidence({ keywords: [], store: "notes" }, {})).resolves.toEqual([]);
  });

  it("an unknown store value that bypasses the type system (bad JSON cast) fails closed to no evidence, not a throw", async () => {
    const deps: ObjectiveEvidenceDeps = { readTasks: async () => [{ title: "anything" }] };
    const bogusQuery = { keywords: [], store: "bogus" } as unknown as EvidenceQuery;
    await expect(resolveObjectiveEvidence(bogusQuery, deps)).resolves.toEqual([]);
  });

  it("a throwing reader is swallowed to no evidence, not a crash", async () => {
    const deps: ObjectiveEvidenceDeps = {
      readTasks: async () => {
        throw new Error("disk error");
      }
    };
    await expect(resolveObjectiveEvidence({ keywords: [], store: "tasks" }, deps)).resolves.toEqual([]);
  });
});

describe("resolveObjectiveEvidence — keyword filter", () => {
  const deps: ObjectiveEvidenceDeps = {
    readTasks: async () => [
      { title: "log the workout" },
      { title: "buy groceries" },
      { title: "WORKOUT streak day 3" }
    ]
  };

  it("matches case-insensitive substrings on any keyword", async () => {
    const records = await resolveObjectiveEvidence({ keywords: ["workout"], store: "tasks" }, deps);
    expect(records.map((r) => r.source)).toEqual(["task:log the workout", "task:WORKOUT streak day 3"]);
  });

  it("an empty keyword list matches everything the store returns", async () => {
    const records = await resolveObjectiveEvidence({ keywords: [], store: "tasks" }, deps);
    expect(records).toHaveLength(3);
  });
});

describe("resolveObjectiveEvidence — window filter", () => {
  it("excludes a record older than windowDays, keeps one inside the window, and never excludes an untimestamped one", async () => {
    const deps: ObjectiveEvidenceDeps = {
      now: () => NOW,
      readTasks: async () => [
        { createdAt: "2026-07-10T00:00:00Z", title: "recent workout" }, // 1 day ago — inside a 7d window
        { createdAt: "2026-06-01T00:00:00Z", title: "old workout" }, // ~40 days ago — outside a 7d window
        { title: "workout no timestamp" }
      ]
    };
    const records = await resolveObjectiveEvidence({ keywords: ["workout"], store: "tasks", windowDays: 7 }, deps);
    expect(records.map((r) => r.source)).toEqual(["task:recent workout", "task:workout no timestamp"]);
  });
});

describe("checkObjectiveMet — deterministic completion check", () => {
  const three = [
    { source: "a", text: "" },
    { source: "b", text: "" },
    { source: "c", text: "" }
  ];
  const two = three.slice(0, 2);

  it("expectedCount present: records.length >= expectedCount ⇒ met", () => {
    expect(checkObjectiveMet(three, { expectedCount: 3 })).toEqual({ evidence: three, met: true });
  });

  it("expectedCount present: fewer records than required ⇒ unmet", () => {
    expect(checkObjectiveMet(two, { expectedCount: 3 })).toEqual({ evidence: two, met: false });
  });

  it("an invalid expectedCount fails closed instead of treating empty evidence as complete", () => {
    expect(checkObjectiveMet([], { expectedCount: 0 })).toEqual({ evidence: [], met: false });
    expect(checkObjectiveMet(three, { expectedCount: -1 })).toEqual({ evidence: three, met: false });
    expect(checkObjectiveMet(three, { expectedCount: 1.5 })).toEqual({ evidence: three, met: false });
  });

  it("no expectedCount: presence (>=1) is enough", () => {
    expect(checkObjectiveMet([three[0]!], {})).toEqual({ evidence: [three[0]], met: true });
    expect(checkObjectiveMet([], {})).toEqual({ evidence: [], met: false });
  });
});

describe("resolveObjectiveEvidence — defensive query normalization", () => {
  it("ignores non-string keywords and an invalid window from an untyped caller", async () => {
    const deps: ObjectiveEvidenceDeps = {
      now: () => NOW,
      readTasks: async () => [{ createdAt: "2026-07-10T00:00:00Z", title: "workout" }]
    };
    const query = { keywords: ["workout", 42], store: "tasks", windowDays: -1 } as unknown as EvidenceQuery;
    await expect(resolveObjectiveEvidence(query, deps)).resolves.toEqual([
      { source: "task:workout", text: "workout", whenIso: "2026-07-10T00:00:00Z" }
    ]);
  });
});
