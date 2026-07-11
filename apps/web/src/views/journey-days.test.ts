import { describe, expect, it } from "vitest";

import { groupJourneyEventsByDay } from "./journey-days.js";

describe("groupJourneyEventsByDay", () => {
  it("groups consecutive same-day events under one day, preserving input order", () => {
    const events = [
      { at: "2026-03-01T10:00:00.000Z", ref: "a" },
      { at: "2026-03-01T09:00:00.000Z", ref: "b" },
      { at: "2026-02-15T00:00:00.000Z", ref: "c" }
    ];
    const groups = groupJourneyEventsByDay(events);
    expect(groups).toEqual([
      { day: "2026-03-01", events: [events[0], events[1]] },
      { day: "2026-02-15", events: [events[2]] }
    ]);
  });

  it("re-opens a day group if the same day appears non-consecutively (order-preserving, not a full re-sort)", () => {
    const events = [
      { at: "2026-03-01T10:00:00.000Z", ref: "a" },
      { at: "2026-02-15T00:00:00.000Z", ref: "b" },
      { at: "2026-03-01T09:00:00.000Z", ref: "c" }
    ];
    const groups = groupJourneyEventsByDay(events);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-01", "2026-02-15", "2026-03-01"]);
  });

  it("empty input produces no groups", () => {
    expect(groupJourneyEventsByDay([])).toEqual([]);
  });
});
