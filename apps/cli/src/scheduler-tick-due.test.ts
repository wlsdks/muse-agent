import { describe, expect, it } from "vitest";

import { isScheduledJobDue, type DueCheckJob } from "./scheduler-tick-due.js";

const job = (overrides: Partial<DueCheckJob> = {}): DueCheckJob => ({
  createdAt: new Date("2026-01-01T00:00:00Z"),
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  ...overrides
});

describe("isScheduledJobDue", () => {
  it("a never-run daily-9am job created at 03:00 is due once 09:00 the same day arrives", () => {
    const created = new Date("2026-06-01T03:00:00Z");
    expect(isScheduledJobDue(job({ createdAt: created }), new Date("2026-06-01T08:59:00Z"))).toBe(false);
    expect(isScheduledJobDue(job({ createdAt: created }), new Date("2026-06-01T09:00:00Z"))).toBe(true);
  });

  it("a never-run daily-9am job created AFTER 09:00 is not due until the next day", () => {
    const created = new Date("2026-06-01T15:00:00Z");
    expect(isScheduledJobDue(job({ createdAt: created }), new Date("2026-06-01T23:00:00Z"))).toBe(false);
    expect(isScheduledJobDue(job({ createdAt: created }), new Date("2026-06-02T09:00:00Z"))).toBe(true);
  });

  it("re-fires exactly once per day once run — not due again until the NEXT occurrence", () => {
    const lastRunAt = new Date("2026-06-01T09:00:05Z"); // fired just after 9am
    expect(isScheduledJobDue(job({ lastRunAt }), new Date("2026-06-01T12:00:00Z"))).toBe(false);
    expect(isScheduledJobDue(job({ lastRunAt }), new Date("2026-06-02T09:00:00Z"))).toBe(true);
  });

  it("restart-safe: a daemon outage spanning several missed days fires ONCE (catch-up, not a backlog storm)", () => {
    const lastRunAt = new Date("2026-06-01T09:00:00Z");
    // The daemon comes back up 4 days later — the job is due (a single catch-up fire).
    expect(isScheduledJobDue(job({ lastRunAt }), new Date("2026-06-05T10:00:00Z"))).toBe(true);
  });

  it("an invalid persisted cron expression is NOT due (fail-closed, never throws)", () => {
    expect(() => isScheduledJobDue(job({ cronExpression: "not a cron" }), new Date())).not.toThrow();
    expect(isScheduledJobDue(job({ cronExpression: "not a cron" }), new Date())).toBe(false);
  });
});
