import { describe, expect, it } from "vitest";

import { composeTodayBrief, createTodayBriefTool, type TodayBriefInput } from "../src/today-brief-tool.js";

const NOW = new Date("2026-06-14T12:00:00"); // local noon
const at = (h: number, m = 0): string => new Date(2026, 5, 14, h, m).toISOString();

describe("composeTodayBrief", () => {
  it("leads with OVERDUE (past-due items) and lists today's remaining items by time", () => {
    const data: TodayBriefInput = {
      tasks: [
        { dueAt: at(9), title: "file taxes" }, // overdue (9am < noon)
        { dueAt: at(15), title: "review PR" } // due later today
      ],
      reminders: [
        { dueAt: at(8), text: "take meds" }, // overdue
        { dueAt: at(14, 30), text: "call the dentist" } // today
      ],
      followups: [
        { scheduledFor: at(10), summary: "circle back with Sam" } // overdue
      ],
      events: [
        { startsAtIso: at(7), title: "morning standup" }, // past — dropped
        { startsAtIso: at(16), title: "design sync" } // today
      ]
    };
    const brief = composeTodayBrief(data, NOW);

    // OVERDUE, soonest-first: meds (8) < taxes (9) < follow-up (10)
    expect(brief.overdue).toEqual([
      "⏰ take meds (overdue)",
      "☑ file taxes (overdue)",
      "↩ circle back with Sam (follow-up overdue)"
    ]);
    // TODAY, by time: dentist (14:30) < PR (no time → end) — events/reminders timed
    expect(brief.today).toContain("14:30 ⏰ call the dentist");
    expect(brief.today).toContain("16:00 design sync");
    expect(brief.today).toContain("☑ review PR (due)");
    // the PAST event is not surfaced (not actionable)
    expect(brief.today.join(" ")).not.toContain("morning standup");
  });

  it("a lookaheadHours window narrows TODAY to now+N hours (the rest of today is excluded)", () => {
    const data: TodayBriefInput = {
      tasks: [],
      reminders: [
        { dueAt: at(13), text: "soon" }, // within +2h
        { dueAt: at(20), text: "tonight" } // beyond +2h
      ],
      followups: [],
      events: []
    };
    const brief = composeTodayBrief(data, NOW, 2); // noon + 2h = 14:00 cutoff
    expect(brief.today).toEqual(["13:00 ⏰ soon"]);
  });

  it("surfaces an IN-PROGRESS event (started before now, still running) — it's on the plate right now", () => {
    const data: TodayBriefInput = {
      tasks: [],
      reminders: [],
      followups: [],
      events: [
        { startsAtIso: at(11, 30), endsAtIso: at(12, 30), title: "design sync" }, // started 11:30, ends 12:30 — ongoing at noon
        { startsAtIso: at(9), endsAtIso: at(10), title: "standup" } // ended before now — dropped
      ]
    };
    const brief = composeTodayBrief(data, NOW);
    expect(brief.today).toContain("11:30 design sync (now)");
    expect(brief.today.join(" ")).not.toContain("standup");
  });

  it("renders an ALL-DAY event as an all-day item, not a misleading '00:00 (now)' timed one", () => {
    const data: TodayBriefInput = {
      tasks: [],
      reminders: [],
      followups: [],
      events: [{ startsAtIso: at(0), endsAtIso: at(23, 59), allDay: true, title: "Alice's birthday" }]
    };
    const brief = composeTodayBrief(data, NOW);
    expect(brief.today).toContain("📅 Alice's birthday (all day)");
    expect(brief.today.join(" ")).not.toContain("00:00");
    expect(brief.today.join(" ")).not.toContain("(now)");
  });

  it("drops unparseable times instead of throwing", () => {
    const data: TodayBriefInput = {
      tasks: [{ dueAt: "not-a-date", title: "garbage" }],
      reminders: [],
      followups: [],
      events: []
    };
    expect(composeTodayBrief(data, NOW)).toEqual({ overdue: [], today: [] });
  });
});

describe("createTodayBriefTool", () => {
  it("is a read-risk tool named today_brief and returns the composed brief", async () => {
    const tool = createTodayBriefTool({
      now: () => NOW,
      todayInput: () => ({
        tasks: [],
        reminders: [{ dueAt: at(8), text: "overdue thing" }],
        followups: [],
        events: []
      })
    });
    expect(tool.definition.name).toBe("today_brief");
    expect(tool.definition.risk).toBe("read");
    const result = (await tool.execute({}, { runId: "t", userId: "u" })) as { overdue: string[]; today: string[] };
    expect(result.overdue).toEqual(["⏰ overdue thing (overdue)"]);
    expect(result.today).toEqual([]);
  });
});
