import { describe, expect, it } from "vitest";

import { formatWeekAgenda, groupWeekAgenda } from "./commands-week.js";

const now = new Date("2026-06-05T09:00:00"); // local Friday

describe("groupWeekAgenda — bucket the next 7 days by local calendar day", () => {
  it("groups events / due tasks / birthdays under the right day, timed events first by time", () => {
    const week = groupWeekAgenda({
      birthdays: [{ daysUntil: 2, name: "Mina" }],
      events: [
        { startsAtIso: "2026-06-05T14:00:00", title: "Lunch" },
        { startsAtIso: "2026-06-05T10:00:00", title: "Standup" }
      ],
      tasks: [{ dueAt: "2026-06-05T23:00:00", title: "Pay rent" }]
    }, now);
    expect(week[0]!.label).toBe("Today — Fri, Jun 5");
    // timed events sorted by time, THEN the untimed task
    expect(week[0]!.lines).toEqual(["10:00 Standup", "14:00 Lunch", "☑ Pay rent (due)"]);
    // birthday 2 days out lands under that day's bucket
    const sunday = week.find((d) => d.lines.some((l) => l.includes("Mina")))!;
    expect(sunday.lines).toContain("🎂 Mina's birthday");
  });

  it("labels day 0 'Today' and day 1 'Tomorrow', and SKIPS empty days", () => {
    const week = groupWeekAgenda({
      birthdays: [],
      events: [{ startsAtIso: "2026-06-06T11:00:00", title: "Dentist" }], // tomorrow only
      tasks: []
    }, now);
    expect(week).toHaveLength(1); // only the day with the event
    expect(week[0]!.label).toBe("Tomorrow — Sat, Jun 6");
    expect(week[0]!.lines).toEqual(["11:00 Dentist"]);
  });

  it("ignores items outside the 7-day window and drops unparseable dates", () => {
    const week = groupWeekAgenda({
      birthdays: [{ daysUntil: 30, name: "Far" }], // beyond the window (daysUntil 30 ≥ 7)
      events: [{ startsAtIso: "not-a-date", title: "Bad" }],
      tasks: [{ dueAt: "2026-07-20T10:00:00", title: "Next month" }]
    }, now);
    expect(week).toEqual([]);
  });

  it("strips untrusted terminal escapes from a third-party event title", () => {
    const week = groupWeekAgenda({ birthdays: [], events: [{ startsAtIso: "2026-06-05T10:00:00", title: "Stand[31mup" }], tasks: [] }, now);
    expect(week[0]!.lines[0]).not.toContain("");
    expect(week[0]!.lines[0]).toContain("10:00");
  });
});

describe("formatWeekAgenda", () => {
  it("renders day headers and indented items", () => {
    const out = formatWeekAgenda([{ label: "Today — Fri, Jun 5", lines: ["10:00 Standup", "☑ Pay rent (due)"] }]);
    expect(out).toContain("📅 This week:");
    expect(out).toContain("  Today — Fri, Jun 5");
    expect(out).toContain("    10:00 Standup");
  });

  it("reports a clear week when nothing is scheduled", () => {
    expect(formatWeekAgenda([])).toContain("Your week ahead is clear");
  });
});
