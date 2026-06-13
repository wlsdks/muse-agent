import { describe, expect, it } from "vitest";

import { createOnThisDayTool, type DatedNote } from "../src/index.js";

describe("createOnThisDayTool — date-cued 'on this day' note recall", () => {
  const NOW = new Date(2026, 5, 13); // 2026-06-13
  const NOTES: DatedNote[] = [
    { date: new Date(2024, 5, 13), id: "journal/2024-06-13.md" }, // 2 years ago, same day
    { date: new Date(2023, 5, 13), id: "journal/2023-06-13.md" }, // 3 years ago, same day
    { date: new Date(2025, 0, 1), id: "journal/2025-01-01.md" }, // off-date
    { date: new Date(2026, 5, 13), id: "journal/2026-06-13.md" } // today THIS year → excluded (prior years only)
  ];
  function tool(notes: DatedNote[] = NOTES) {
    return createOnThisDayTool({ datedNotes: () => notes, now: () => NOW });
  }

  it("is risk:read and returns only prior-year notes on today's date, most-recent first (value flows through selectOnThisDay)", async () => {
    const t = tool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({}) as { count: number; windowDays: number; onThisDay: { id: string; yearsAgo: number; date: string }[] };
    expect(out.count).toBe(2);
    expect(out.onThisDay.map((h) => h.id)).toEqual(["journal/2024-06-13.md", "journal/2023-06-13.md"]);
    expect(out.onThisDay[0]).toMatchObject({ date: "2024-06-13", id: "journal/2024-06-13.md", yearsAgo: 2 });
    // This year's same-date note and the off-date note never appear.
    expect(out.onThisDay.map((h) => h.id)).not.toContain("journal/2026-06-13.md");
    expect(out.onThisDay.map((h) => h.id)).not.toContain("journal/2025-01-01.md");
  });

  it("returns an empty list (count 0) when nothing matches today", async () => {
    const out = await tool([{ date: new Date(2020, 0, 1), id: "journal/2020-01-01.md" }]).execute({}) as { count: number; onThisDay: unknown[] };
    expect(out.count).toBe(0);
    expect(out.onThisDay).toEqual([]);
  });

  it("matches across the Jan-1 year boundary within the window (Dec 31 is 'on this day' for a Jan-1 now)", async () => {
    const newYearNow = new Date(2026, 0, 1); // 2026-01-01
    const dec31LastYear: DatedNote[] = [{ date: new Date(2024, 11, 31), id: "journal/2024-12-31.md" }]; // 1 day before, prior year
    const t = createOnThisDayTool({ datedNotes: () => dec31LastYear, now: () => newYearNow });
    // Outside the default 0-day window.
    expect((await t.execute({}) as { count: number }).count).toBe(0);
    // Within ±3 days, the Dec-31 anniversary IS one day off Jan 1 — must surface.
    const windowed = await t.execute({ windowDays: 3 }) as { count: number; onThisDay: { id: string }[] };
    expect(windowed.count).toBe(1);
    expect(windowed.onThisDay[0]!.id).toBe("journal/2024-12-31.md");
    // A note genuinely ~half a year away must NOT spuriously match the boundary.
    const farJuly: DatedNote[] = [{ date: new Date(2024, 6, 1), id: "journal/2024-07-01.md" }];
    const farTool = createOnThisDayTool({ datedNotes: () => farJuly, now: () => newYearNow });
    expect((await farTool.execute({ windowDays: 7 }) as { count: number }).count).toBe(0);
  });

  it("honors a windowDays window (±N days) and clamps out-of-range to the 0..7 bounds", async () => {
    // Jun 15 is 2 days off today (Jun 13): excluded at the default window 0, included at ±3.
    const near: DatedNote[] = [{ date: new Date(2024, 5, 15), id: "journal/2024-06-15.md" }];
    expect((await tool(near).execute({}) as { count: number }).count).toBe(0);
    const windowed = await tool(near).execute({ windowDays: 3 }) as { count: number; windowDays: number };
    expect(windowed.windowDays).toBe(3);
    expect(windowed.count).toBe(1);
    // out-of-range clamps to the schema max (7) rather than a NaN/huge window.
    expect((await tool(near).execute({ windowDays: 999 }) as { windowDays: number }).windowDays).toBe(7);
  });
});
