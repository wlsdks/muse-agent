import { describe, expect, it } from "vitest";

import { createWeekAgendaTool, type WeekAgendaInput } from "../src/index.js";

const NOW = new Date("2026-06-05T12:00:00");
const INPUT: WeekAgendaInput = {
  birthdays: [{ daysUntil: 2, name: "Bob" }], // +2 days
  events: [
    { startsAtIso: "2026-06-05T15:00:00", title: "Standup" }, // today
    { startsAtIso: "2026-06-06T10:00:00", title: "Dentist" } // tomorrow
  ],
  tasks: [{ dueAt: "2026-06-08T09:00:00", title: "file taxes" }] // +3 days
};

function tool(data: WeekAgendaInput = INPUT) {
  return createWeekAgendaTool({ now: () => NOW, weekInput: () => data });
}

describe("createWeekAgendaTool — the week at a glance", () => {
  it("is risk:read and merges events/tasks/birthdays into the right days (value flows through groupWeekAgenda)", async () => {
    const t = tool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({}) as { days: number; week: { label: string; items: string[] }[] };
    expect(out.days).toBe(7);
    const today = out.week.find((d) => d.label.startsWith("Today"));
    expect(today?.items.some((x) => x.includes("Standup"))).toBe(true);
    const tomorrow = out.week.find((d) => d.label.startsWith("Tomorrow"));
    expect(tomorrow?.items.some((x) => x.includes("Dentist"))).toBe(true);
    expect(out.week.some((d) => d.items.some((x) => x.includes("🎂") && x.includes("Bob")))).toBe(true);
    expect(out.week.some((d) => d.items.some((x) => x.includes("☑") && x.includes("file taxes")))).toBe(true);
  });

  it("respects a days window and clamps out-of-range (a +3-day task falls outside a 2-day window)", async () => {
    const out = await tool().execute({ days: 2 }) as { days: number; week: { items: string[] }[] };
    expect(out.days).toBe(2);
    expect(out.week.flatMap((d) => d.items).some((x) => x.includes("file taxes"))).toBe(false);
  });

  it("returns an empty week when nothing is scheduled", async () => {
    const out = await tool({ birthdays: [], events: [], tasks: [] }).execute({}) as { week: unknown[] };
    expect(out.week).toEqual([]);
  });
});
