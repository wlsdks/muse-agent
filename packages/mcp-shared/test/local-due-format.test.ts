import { describe, expect, it } from "vitest";

import { formatDueLocal } from "../src/local-due-format.js";

// formatDueLocal renders a due instant in the server's local TZ plus a relative
// hint. personal-reminders-serialize.test.ts pins the overdue / "in N minutes" /
// unparseable-echo branches precisely, but the day-granularity hints were only
// loosely OR-matched (`/(tomorrow|today|in \d+ days)/`). Pin them branch-precise.
// TZ-independent: a due anchored to the same wall-clock N*24h out is exactly N
// local days away regardless of the server offset (localDayIndex shifts `due`
// and `now` by the same getTimezoneOffset), so we assert only the relative suffix.
describe("formatDueLocal — day-granularity relative hint (branch-precise)", () => {
  const now = new Date("2026-06-04T12:00:00.000Z");

  it("labels a due exactly 24h out (same wall-clock) 'tomorrow'", () => {
    expect(formatDueLocal("2026-06-05T12:00:00.000Z", () => now)).toMatch(/\(tomorrow\)$/u);
  });

  it("labels a due 3 days out 'in 3 days'", () => {
    expect(formatDueLocal("2026-06-07T12:00:00.000Z", () => now)).toMatch(/\(in 3 days\)$/u);
  });
});
