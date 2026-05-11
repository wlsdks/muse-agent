import { describe, expect, it } from "vitest";

import {
  DefaultActiveContextProvider,
  renderActiveContextSection,
  type ActiveContextSnapshot
} from "../src/active-context.js";

const fixedNow = new Date("2026-05-11T12:00:00.000Z");

describe("renderActiveContextSection", () => {
  it("renders a header and time line at minimum", () => {
    const snapshot: ActiveContextSnapshot = {
      localHour: 12,
      nowIso: fixedNow.toISOString(),
      timezone: "UTC",
      weekday: "Monday"
    };
    const rendered = renderActiveContextSection(snapshot);
    expect(rendered).toContain("[Active Context]");
    expect(rendered).toContain("now=2026-05-11T12:00:00.000Z");
    expect(rendered).toContain("Monday");
  });

  it("includes working_hours and in_window status", () => {
    const snapshot: ActiveContextSnapshot = {
      isWorkingHours: true,
      localHour: 12,
      nowIso: fixedNow.toISOString(),
      timezone: "UTC",
      weekday: "Monday",
      workingHours: { end: 17, start: 9 }
    };
    const rendered = renderActiveContextSection(snapshot);
    expect(rendered).toContain("working_hours=9-17");
    expect(rendered).toContain("in_window=yes");
  });

  it("includes active task when present", () => {
    const snapshot: ActiveContextSnapshot = {
      activeTask: { dueIso: "2026-05-12T00:00:00.000Z", id: "T-1", title: "Ship feature" },
      localHour: 12,
      nowIso: fixedNow.toISOString(),
      timezone: "UTC",
      weekday: "Monday"
    };
    const rendered = renderActiveContextSection(snapshot);
    expect(rendered).toContain("active_task: Ship feature");
    expect(rendered).toContain("id=T-1");
    expect(rendered).toContain("due=2026-05-12T00:00:00.000Z");
  });

  it("returns undefined for undefined snapshot", () => {
    expect(renderActiveContextSection(undefined)).toBeUndefined();
  });
});

describe("DefaultActiveContextProvider", () => {
  it("always returns at least nowIso + timezone + weekday", async () => {
    const provider = new DefaultActiveContextProvider({ defaultTimezone: "UTC", now: () => fixedNow });
    const snapshot = await provider.resolve();
    expect(snapshot?.nowIso).toBe(fixedNow.toISOString());
    expect(snapshot?.timezone).toBe("UTC");
    expect(snapshot?.weekday).toMatch(/Monday/u);
  });

  it("reads working_hours from user memory preferences", async () => {
    const memoryProvider = {
      async findByUserId() {
        return {
          facts: {},
          preferences: { timezone: "UTC", working_hours: "9-17" },
          userId: "u1"
        };
      }
    };
    const provider = new DefaultActiveContextProvider({
      defaultTimezone: "UTC",
      now: () => fixedNow,
      userMemoryProvider: memoryProvider
    });
    const snapshot = await provider.resolve("u1");
    expect(snapshot?.workingHours).toEqual({ end: 17, start: 9 });
    expect(snapshot?.isWorkingHours).toBe(true);
  });

  it("fails open when user memory throws", async () => {
    const provider = new DefaultActiveContextProvider({
      defaultTimezone: "UTC",
      now: () => fixedNow,
      userMemoryProvider: {
        async findByUserId() {
          throw new Error("boom");
        }
      }
    });
    const snapshot = await provider.resolve("u1");
    expect(snapshot?.nowIso).toBe(fixedNow.toISOString());
  });

  it("loads active task from resolver when configured", async () => {
    const provider = new DefaultActiveContextProvider({
      activeTaskResolver: {
        async resolve() {
          return { id: "T-9", title: "Drafting plan" };
        }
      },
      defaultTimezone: "UTC",
      now: () => fixedNow
    });
    const snapshot = await provider.resolve("u1");
    expect(snapshot?.activeTask).toEqual({ id: "T-9", title: "Drafting plan" });
  });
});
