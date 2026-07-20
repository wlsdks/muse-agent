import { describe, expect, it } from "vitest";

import { groundedSourceSummary, type GroundedSourceCounts } from "./present.js";

const noneMatched: GroundedSourceCounts = {
  notesPart: null,
  openTasks: 0,
  upcomingEvents: 0,
  pendingReminders: 0,
  contacts: 0,
  automationFlows: 0,
  memories: 0,
  shellCommands: 0,
  gitCommits: 0,
  loggedActions: 0,
  pastSessions: 0,
  feedHeadlines: 0,
  browsingVisits: 0
};

describe("groundedSourceSummary", () => {
  it("returns [] when nothing matched (no banner)", () => {
    expect(groundedSourceSummary(noneMatched)).toEqual([]);
  });

  it("puts the caller-built note part first, then count-labelled parts in source order", () => {
    expect(
      groundedSourceSummary({
        ...noneMatched,
        notesPart: "3 note chunk(s) — a.md, b.md",
        openTasks: 2,
        feedHeadlines: 5
      })
    ).toEqual(["3 note chunk(s) — a.md, b.md", "2 open task(s)", "5 feed headline(s)"]);
  });

  it("omits the note part when null but keeps the count parts", () => {
    expect(groundedSourceSummary({ ...noneMatched, pendingReminders: 1 })).toEqual(["1 pending reminder(s)"]);
  });

  it("uses the exact singular/plural-agnostic '(s)' label for every source", () => {
    expect(
      groundedSourceSummary({
        notesPart: null,
        openTasks: 1,
        upcomingEvents: 1,
        pendingReminders: 1,
        contacts: 1,
        automationFlows: 1,
        memories: 1,
        shellCommands: 1,
        gitCommits: 1,
        loggedActions: 1,
        pastSessions: 1,
        feedHeadlines: 1,
        browsingVisits: 1
      })
    ).toEqual([
      "1 open task(s)",
      "1 upcoming event(s)",
      "1 pending reminder(s)",
      "1 contact(s)",
      "1 automation(s)",
      "1 remembered fact(s)",
      "1 shell command(s)",
      "1 git commit(s)",
      "1 logged action(s)",
      "1 past session(s)",
      "1 feed headline(s)",
      "1 page(s) you visited"
    ]);
  });
});
