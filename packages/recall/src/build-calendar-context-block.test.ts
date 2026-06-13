import { describe, expect, it } from "vitest";

import { buildCalendarContextBlock } from "./present.js";

// Assertions avoid the exact toLocaleString output (timezone-dependent); they pin the
// structural wrapper, citation, provider, location, and the all-day vs timed shape.
function ev(over: Partial<{ title: string; startsAt: Date; endsAt: Date; allDay: boolean; location?: string; providerId: string }> = {}) {
  return { title: "Standup", startsAt: new Date("2026-06-15T09:00:00.000Z"), endsAt: new Date("2026-06-15T09:30:00.000Z"), allDay: false, providerId: "local", ...over } as never;
}

describe("buildCalendarContextBlock — <<event N>> grounding block", () => {
  it("empty → placeholder", () => {
    expect(buildCalendarContextBlock([])).toBe("(no upcoming events)");
  });
  it("wraps each event with [providerId] header, title, and [event: <title>] citation (title, not id)", () => {
    const block = buildCalendarContextBlock([ev({ title: "Dentist", providerId: "gcal" })]);
    expect(block).toContain("<<event 1 — [gcal]>>");
    expect(block).toContain("\nDentist");
    expect(block).toContain("[event: Dentist]");
    expect(block).toContain("<<end>>");
  });
  it("appends ` @ location` only when location is set", () => {
    expect(buildCalendarContextBlock([ev({ title: "Lunch", location: "Cafe" })])).toContain("Lunch @ Cafe\n");
    expect(buildCalendarContextBlock([ev({ title: "Lunch" })])).toContain("Lunch\n");
    expect(buildCalendarContextBlock([ev({ title: "Lunch" })])).not.toContain(" @ ");
  });
  it("all-day → '(all-day, YYYY-MM-DD)'; timed → 'to … (full ISO)'", () => {
    const allDay = buildCalendarContextBlock([ev({ allDay: true, startsAt: new Date("2026-06-15T00:00:00.000Z") })]);
    expect(allDay).toContain("(all-day, 2026-06-15)");
    const timed = buildCalendarContextBlock([ev({})]);
    expect(timed).toContain(" to ");
    expect(timed).toContain("(2026-06-15T09:00:00.000Z)");
  });
  it("separates multiple events with a blank line", () => {
    const block = buildCalendarContextBlock([ev({ title: "a" }), ev({ title: "b" })]);
    expect(block).toContain("<<end>>\n\n<<event 2");
  });
});
