import { describe, expect, it } from "vitest";

import { composeSituationalBriefing, type BriefingImminent } from "./situational-briefing.js";
import type { StandingObjective } from "@muse/stores";

const NOW = new Date("2026-05-19T12:00:00.000Z");

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T10:00:00.000Z",
    id: "obj_1",
    kind: "until",
    spec: "watch the CI build until it goes green",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

function imminent(title: string, offsetMin: number, kind = "calendar"): BriefingImminent {
  return { kind, startsAt: new Date(NOW.getTime() + offsetMin * 60_000), title };
}

describe("composeSituationalBriefing — P8-b1 one synthesised heads-up, not N notices", () => {
  it("composes imminent + escalated + active into ONE briefing, soonest-first", () => {
    const text = composeSituationalBriefing({
      imminent: [imminent("Q3 review", 30), imminent("Standup", 5)],
      now: NOW,
      objectives: [
        objective({ id: "a", spec: "watch the deploy" }),
        objective({ id: "b", resolution: "max attempts exhausted", spec: "open the changelog issue", status: "escalated" }),
        objective({ id: "c", spec: "this is done", status: "done" })
      ]
    });
    expect(text).toBeDefined();
    // One message, sectioned.
    expect(text).toContain("[Briefing]");
    // Soonest-first: Standup (5 min) before Q3 review (30 min).
    expect(text!.indexOf("Standup")).toBeLessThan(text!.indexOf("Q3 review"));
    expect(text).toContain("- in 5 min: Standup");
    expect(text).toContain("- in 30 min: Q3 review");
    // Escalated is flagged "Needs you" with its resolution.
    expect(text).toContain("Needs you:");
    expect(text).toContain("- ⚠ open the changelog issue — max attempts exhausted");
    // Active is "Still tracking".
    expect(text).toContain("Still tracking:");
    expect(text).toContain("- watch the deploy");
    // done/cancelled are excluded.
    expect(text).not.toContain("this is done");
  });

  it("returns undefined when there is nothing worth saying", () => {
    expect(composeSituationalBriefing({ imminent: [], now: NOW, objectives: [] })).toBeUndefined();
    // Only finished objectives + no imminent ⇒ still nothing.
    expect(
      composeSituationalBriefing({
        imminent: [],
        now: NOW,
        objectives: [objective({ status: "done" }), objective({ id: "x", status: "cancelled" })]
      })
    ).toBeUndefined();
  });

  it("a single active objective with no imminent items still briefs (Delegated only)", () => {
    const text = composeSituationalBriefing({ imminent: [], now: NOW, objectives: [objective()] });
    expect(text).toContain("Still tracking:");
    expect(text).toContain("watch the CI build until it goes green");
    expect(text).not.toContain("Upcoming:");
  });

  it("a past/now imminent item reads 'now'; an unparseable startsAt is dropped, not NaN-rendered", () => {
    const text = composeSituationalBriefing({
      imminent: [
        imminent("happening now", 0),
        { kind: "task", startsAt: new Date("not a date"), title: "garbage" }
      ],
      now: NOW,
      objectives: []
    });
    expect(text).toContain("- now: happening now");
    expect(text).not.toContain("garbage");
    expect(text).not.toContain("NaN");
  });

  it("collapses whitespace in a multiline title/spec so it cannot break the section layout", () => {
    const text = composeSituationalBriefing({
      imminent: [imminent("line one\nline two", 10)],
      now: NOW,
      objectives: [objective({ spec: "spec\n\nwith   gaps" })]
    });
    expect(text).toContain("- in 10 min: line one line two");
    expect(text).toContain("- spec with gaps");
  });
});
