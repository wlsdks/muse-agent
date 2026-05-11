import { describe, expect, it } from "vitest";

import {
  DefaultActiveContextProvider,
  renderActiveContextSection,
  type CalendarEventsResolver
} from "../src/active-context.js";

const fixedNow = new Date("2026-05-11T08:00:00.000Z");

describe("active context calendar surface (D1)", () => {
  it("renders today_events block with chronological order", () => {
    const rendered = renderActiveContextSection({
      localHour: 8,
      nowIso: fixedNow.toISOString(),
      timezone: "UTC",
      todaysEvents: [
        { endIso: "2026-05-11T10:00:00.000Z", startIso: "2026-05-11T09:00:00.000Z", title: "Standup" },
        { allDay: true, location: "HQ", startIso: "2026-05-11T00:00:00.000Z", title: "Quarterly Planning" }
      ],
      weekday: "Monday"
    });
    expect(rendered).toContain("today_events:");
    expect(rendered).toContain("Standup");
    expect(rendered).toContain("Quarterly Planning");
    expect(rendered).toContain("@ HQ");
    expect(rendered).toContain("(all day)");
  });

  it("annotates events with human-readable relative time (iter 7)", () => {
    // fixedNow is 2026-05-11T08:00:00.000Z
    const rendered = renderActiveContextSection({
      localHour: 8,
      nowIso: fixedNow.toISOString(),
      timezone: "UTC",
      todaysEvents: [
        // Freshly-ended event — within the iter-40 30-min grace
        // window so still rendered. Ended at 07:45 (15 min ago).
        { endIso: "2026-05-11T07:45:00.000Z", startIso: "2026-05-11T07:00:00.000Z", title: "Morning yoga" },
        // Happening right now (07:30 → 09:00)
        { endIso: "2026-05-11T09:00:00.000Z", startIso: "2026-05-11T07:30:00.000Z", title: "Standup" },
        // 30 minutes from now
        { endIso: "2026-05-11T09:00:00.000Z", startIso: "2026-05-11T08:30:00.000Z", title: "Sync with PM" },
        // 4 hours from now
        { endIso: "2026-05-11T13:00:00.000Z", startIso: "2026-05-11T12:00:00.000Z", title: "Lunch with Alex" }
      ],
      weekday: "Monday"
    });
    expect(rendered).toContain("[ended]");
    expect(rendered).toContain("[happening now]");
    expect(rendered).toContain("[in 30 min]");
    expect(rendered).toContain("[in 4h]");
  });

  it("annotates active_task due time relative to now (iter 7)", () => {
    const rendered = renderActiveContextSection({
      activeTask: { dueIso: "2026-05-11T09:00:00.000Z", id: "T-1", title: "Ship the doc" },
      localHour: 8,
      nowIso: fixedNow.toISOString(),
      timezone: "UTC",
      weekday: "Monday"
    });
    expect(rendered).toContain("active_task: Ship the doc · id=T-1");
    expect(rendered).toContain("(in 1h)");
  });

  it("DefaultActiveContextProvider feeds events through the resolver", async () => {
    const resolver: CalendarEventsResolver = {
      async resolve() {
        return [
          { endIso: "2026-05-11T10:00:00.000Z", startIso: "2026-05-11T09:00:00.000Z", title: "Standup" }
        ];
      }
    };
    const provider = new DefaultActiveContextProvider({
      calendarEventsResolver: resolver,
      defaultTimezone: "UTC",
      now: () => fixedNow
    });
    const snapshot = await provider.resolve();
    expect(snapshot?.todaysEvents).toHaveLength(1);
    expect(snapshot?.todaysEvents?.[0]?.title).toBe("Standup");
  });

  it("fails open when calendar resolver throws", async () => {
    const provider = new DefaultActiveContextProvider({
      calendarEventsResolver: {
        async resolve() {
          throw new Error("network down");
        }
      },
      defaultTimezone: "UTC",
      now: () => fixedNow
    });
    const snapshot = await provider.resolve();
    expect(snapshot?.todaysEvents).toBeUndefined();
    // base fields still populated
    expect(snapshot?.nowIso).toBe(fixedNow.toISOString());
  });
});
