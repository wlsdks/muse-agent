import { describe, expect, it } from "vitest";

import type { ScheduledJob } from "./index.js";
import { SchedulerValidationError } from "./scheduler-errors.js";
import {
  defaultRetryCount,
  defaultTimezone,
  computeNextRunAt,
  maxRetryCountCeiling,
  normalizeScheduledJobExecution,
  renderTemplateVariables,
  requireText,
  resolveJobTimeout,
  validateCronExpression,
  validateExecutionTimeout,
  validateJobName,
  validateRetryConfig,
  validateTimezone
} from "./scheduler-helpers.js";

describe("validateTimezone", () => {
  it("accepts a valid IANA zone", () => {
    expect(() => validateTimezone("Asia/Seoul")).not.toThrow();
    expect(() => validateTimezone("UTC")).not.toThrow();
  });
  it("throws SchedulerValidationError for an invalid zone", () => {
    expect(() => validateTimezone("Atlantis/Mu")).toThrow(SchedulerValidationError);
  });
});

describe("validateCronExpression", () => {
  it("accepts a standard 5-field cron", () => {
    expect(() => validateCronExpression("0 8 * * 1")).not.toThrow();
  });
  it("accepts a 6-field cron (with seconds)", () => {
    expect(() => validateCronExpression("0 0 8 * * 1")).not.toThrow();
  });
  it("throws for the wrong field count", () => {
    expect(() => validateCronExpression("0 8 * *")).toThrow(SchedulerValidationError);
    expect(() => validateCronExpression("0 8 * * * * *")).toThrow(SchedulerValidationError);
  });
  it("throws when cron-parser rejects the value", () => {
    expect(() => validateCronExpression("not a cron")).toThrow(SchedulerValidationError);
  });
  it("accepts cron nickname macros the parser+runtime support (consistent with computeNextRunAt)", () => {
    for (const macro of ["@daily", "@hourly", "@weekly", "@monthly", "@yearly", "@annually"]) {
      expect(() => validateCronExpression(macro)).not.toThrow();
      // The runtime that actually schedules the job accepts it too.
      expect(() =>
        computeNextRunAt({ cronExpression: macro, timezone: "UTC" }, new Date("2026-05-19T08:00:00Z"))
      ).not.toThrow();
    }
    expect(
      computeNextRunAt({ cronExpression: "@daily", timezone: "UTC" }, new Date("2026-05-19T08:00:00Z")).toISOString()
    ).toBe("2026-05-20T00:00:00.000Z");
  });
  it("still rejects a macro the pinned runtime can't resolve (validation == computeNextRunAt)", () => {
    // `@every 5m` and `@midnight` are NOT supported by the pinned
    // cron-parser (computeNextRunAt throws on both) — validation
    // must stay consistent and never green-light a cron the
    // scheduler would then fail to compute a next-run for.
    for (const bad of ["@every 5m", "@midnight"]) {
      expect(() => validateCronExpression(bad)).toThrow(SchedulerValidationError);
      expect(() =>
        computeNextRunAt({ cronExpression: bad, timezone: "UTC" }, new Date("2026-05-19T08:00:00Z"))
      ).toThrow();
    }
  });
});

describe("computeNextRunAt fails closed on a blank / corrupt cron", () => {
  const from = new Date("2026-05-19T12:00:00Z");

  it("throws (not silently 'every minute') for blank / whitespace / short-field crons", () => {
    // The lenient cron-parser turns "" into a fire-every-minute
    // schedule and a 4-field expression into a misread one.
    // normalize/load does not re-validate, so the compute
    // chokepoint must — accept ⟺ validateCronExpression.
    for (const corrupt of ["", "   ", "\t", "0 8 * *", "0 8 * * * * *"]) {
      expect(() => validateCronExpression(corrupt)).toThrow(SchedulerValidationError);
      expect(() =>
        computeNextRunAt({ cronExpression: corrupt, timezone: "UTC" }, from)
      ).toThrow(SchedulerValidationError);
    }
  });

  it("still computes the next run for every valid cron (no regression)", () => {
    expect(computeNextRunAt({ cronExpression: "* * * * *", timezone: "UTC" }, from).toISOString())
      .toBe("2026-05-19T12:01:00.000Z");
    expect(computeNextRunAt({ cronExpression: "* * * * * *", timezone: "UTC" }, from).toISOString())
      .toBe("2026-05-19T12:00:01.000Z");
    expect(computeNextRunAt({ cronExpression: "@daily", timezone: "UTC" }, from).toISOString())
      .toBe("2026-05-20T00:00:00.000Z");
    expect(computeNextRunAt({ cronExpression: "0 9 * * 1-5", timezone: "UTC" }, from).toISOString())
      .toBe("2026-05-20T09:00:00.000Z");
  });

  it("applies the job timezone — '0 9 * * *' resolves to the right UTC instant per zone, not silently UTC", () => {
    // The same '9am daily' cron fires at DIFFERENT UTC instants by zone; a
    // regression that dropped the `tz` option would make all three equal to the
    // UTC answer and silently fire reminders at the wrong local hour.
    const at = new Date("2026-05-19T08:00:00Z");
    const utc = computeNextRunAt({ cronExpression: "0 9 * * *", timezone: "UTC" }, at).toISOString();
    const seoul = computeNextRunAt({ cronExpression: "0 9 * * *", timezone: "Asia/Seoul" }, at).toISOString();
    const newYork = computeNextRunAt({ cronExpression: "0 9 * * *", timezone: "America/New_York" }, at).toISOString();
    expect(utc).toBe("2026-05-19T09:00:00.000Z");      // 09:00Z today
    expect(seoul).toBe("2026-05-20T00:00:00.000Z");    // 9am KST (UTC+9) = 00:00Z, next is tomorrow
    expect(newYork).toBe("2026-05-19T13:00:00.000Z");  // 9am EDT (UTC-4 in May) = 13:00Z today
    expect(new Set([utc, seoul, newYork]).size).toBe(3); // tz genuinely changes the instant
  });
});

describe("validateJobName", () => {
  it("accepts a non-blank name", () => {
    expect(() => validateJobName("morning-brief")).not.toThrow();
  });
  it("throws for blank / whitespace-only names", () => {
    expect(() => validateJobName("")).toThrow(SchedulerValidationError);
    expect(() => validateJobName("   ")).toThrow(SchedulerValidationError);
  });
});

describe("validateExecutionTimeout", () => {
  it("accepts undefined and 0 (disable)", () => {
    expect(() => validateExecutionTimeout(undefined)).not.toThrow();
    expect(() => validateExecutionTimeout(0)).not.toThrow();
  });
  it("accepts in-range timeouts", () => {
    expect(() => validateExecutionTimeout(1_000)).not.toThrow();
    expect(() => validateExecutionTimeout(3_600_000)).not.toThrow();
  });
  it("throws for out-of-range timeouts", () => {
    expect(() => validateExecutionTimeout(999)).toThrow(SchedulerValidationError);
    expect(() => validateExecutionTimeout(3_600_001)).toThrow(SchedulerValidationError);
  });
  it("throws for non-finite timeouts (NaN / Infinity / -Infinity) — they slip past raw < / > comparisons", () => {
    expect(() => validateExecutionTimeout(Number.NaN), "NaN must reject — raw comparisons return false against any number, so the range check would silently pass it through to the runtime").toThrow(SchedulerValidationError);
    expect(() => validateExecutionTimeout(Number.POSITIVE_INFINITY)).toThrow(SchedulerValidationError);
    expect(() => validateExecutionTimeout(Number.NEGATIVE_INFINITY)).toThrow(SchedulerValidationError);
  });
});

describe("validateRetryConfig", () => {
  it("accepts retryOnFailure=false regardless of maxRetryCount", () => {
    expect(() => validateRetryConfig(false, 0)).not.toThrow();
    expect(() => validateRetryConfig(false, Number.NaN), "even NaN slips through when retryOnFailure is false — the field is unused").not.toThrow();
  });
  it("requires maxRetryCount >= 1 when retryOnFailure=true", () => {
    expect(() => validateRetryConfig(true, 1)).not.toThrow();
    expect(() => validateRetryConfig(true, 0)).toThrow(SchedulerValidationError);
  });
  it("throws for non-finite maxRetryCount (NaN / Infinity / -Infinity) when retryOnFailure=true — they slip past raw `< 1` comparisons", () => {
    expect(() => validateRetryConfig(true, Number.NaN), "NaN < 1 is false, so without the finite guard the gate would silently accept a non-finite retry count").toThrow(SchedulerValidationError);
    expect(() => validateRetryConfig(true, Number.POSITIVE_INFINITY)).toThrow(SchedulerValidationError);
    expect(() => validateRetryConfig(true, Number.NEGATIVE_INFINITY)).toThrow(SchedulerValidationError);
  });
  it("rejects a maxRetryCount above the ceiling so a `maxRetryCount: 1_000_000` config can't turn runWithRetry into a retry-storm against the job target", () => {
    expect(() => validateRetryConfig(true, maxRetryCountCeiling)).not.toThrow();
    expect(() => validateRetryConfig(true, maxRetryCountCeiling + 1)).toThrow(SchedulerValidationError);
    expect(() => validateRetryConfig(true, 1_000_000)).toThrow(SchedulerValidationError);
  });
  it("rejects a non-integer maxRetryCount (a retry COUNT is a whole number) when retryOnFailure=true", () => {
    expect(() => validateRetryConfig(true, 3.5)).toThrow(SchedulerValidationError);
    expect(() => validateRetryConfig(true, 3)).not.toThrow();
  });
});

describe("scheduler retry ceiling", () => {
  it("maxRetryCountCeiling is 100 — generous for legitimate jobs, bounded against a retry bomb", () => {
    expect(maxRetryCountCeiling).toBe(100);
  });
});

describe("requireText", () => {
  it("returns the trimmed text when non-blank", () => {
    expect(requireText("  hello  ", "x")).toBe("hello");
  });
  it("throws for blank / undefined / null", () => {
    expect(() => requireText(undefined, "missing")).toThrow(SchedulerValidationError);
    expect(() => requireText(null, "missing")).toThrow(SchedulerValidationError);
    expect(() => requireText("   ", "missing")).toThrow(SchedulerValidationError);
  });
});

describe("scheduler defaults", () => {
  it("defaultTimezone is UTC", () => {
    expect(defaultTimezone).toBe("UTC");
  });
  it("defaultRetryCount is 3", () => {
    expect(defaultRetryCount).toBe(3);
  });
});

describe("resolveJobTimeout — defends against a corrupt persisted executionTimeoutMs", () => {
  const baseJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
    cronExpression: "* * * * *",
    createdAt: new Date("2026-05-20T00:00:00Z"),
    enabled: true,
    id: "j-1",
    jobType: "mcp_tool",
    maxRetryCount: 3,
    name: "j",
    retryOnFailure: false,
    tags: [],
    timezone: "UTC",
    toolArguments: {},
    updatedAt: new Date("2026-05-20T00:00:00Z"),
    ...overrides
  });

  it("returns the explicit executionTimeoutMs when it is a finite positive number", () => {
    expect(resolveJobTimeout(baseJob({ executionTimeoutMs: 30_000 }), 60_000)).toBe(30_000);
  });

  it("falls back to the supplied fallback when executionTimeoutMs is undefined", () => {
    expect(resolveJobTimeout(baseJob(), 60_000)).toBe(60_000);
  });

  it("falls back when executionTimeoutMs is NaN — `??` does NOT catch NaN, so a corrupt row would otherwise propagate", () => {
    expect(resolveJobTimeout(baseJob({ executionTimeoutMs: Number.NaN }), 60_000)).toBe(60_000);
  });

  it("falls back when executionTimeoutMs is Infinity or negative or zero (non-positive)", () => {
    expect(resolveJobTimeout(baseJob({ executionTimeoutMs: Number.POSITIVE_INFINITY }), 60_000)).toBe(60_000);
    expect(resolveJobTimeout(baseJob({ executionTimeoutMs: -1 }), 60_000)).toBe(60_000);
    expect(resolveJobTimeout(baseJob({ executionTimeoutMs: 0 }), 60_000)).toBe(60_000);
  });
});

describe("renderTemplateVariables — time rendering at midnight (h23, not the h24 '24:00:00' quirk)", () => {
  const job = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
    cronExpression: "0 0 * * *",
    createdAt: new Date("2026-05-20T00:00:00Z"),
    enabled: true,
    id: "j-mid",
    jobType: "agent",
    maxRetryCount: 3,
    name: "Midnight digest",
    retryOnFailure: false,
    tags: [],
    timezone: "UTC",
    toolArguments: {},
    updatedAt: new Date("2026-05-20T00:00:00Z"),
    ...overrides
  });

  it("renders midnight {{time}} as 00:00:00, not 24:00:00 (hour12:false maps to h24)", () => {
    const midnight = new Date("2026-05-22T00:00:00Z");
    expect(renderTemplateVariables("at {{time}}", job(), midnight)).toBe("at 00:00:00");
    expect(renderTemplateVariables("{{datetime}}", job(), midnight)).toBe("2026-05-22 00:00:00");
  });

  it("renders a midday time unchanged, and substitutes date / job fields", () => {
    const midday = new Date("2026-05-22T13:05:09Z");
    expect(renderTemplateVariables("{{date}} {{time}} — {{job_name}}", job(), midday))
      .toBe("2026-05-22 13:05:09 — Midnight digest");
  });

  it("honours the job timezone so midnight is local, still 00 not 24", () => {
    // 2026-05-22T15:00:00Z == 2026-05-23T00:00:00 in Asia/Seoul (UTC+9).
    const localMidnight = new Date("2026-05-22T15:00:00Z");
    expect(renderTemplateVariables("{{datetime}}", job({ timezone: "Asia/Seoul" }), localMidnight))
      .toBe("2026-05-23 00:00:00");
  });
});

describe("normalizeScheduledJobExecution durationMs guard", () => {
  const opts = { id: "exec_1", now: () => new Date("2026-05-20T12:00:00.000Z") };
  const base = {
    jobId: "job_1",
    jobName: "midnight-sync",
    status: "success" as const
  };

  it("preserves a clean finite durationMs", () => {
    expect(normalizeScheduledJobExecution({ ...base, durationMs: 1234 }, opts).durationMs).toBe(1234);
    expect(normalizeScheduledJobExecution({ ...base, durationMs: 0 }, opts).durationMs).toBe(0);
  });

  it("falls back to 0 when durationMs is undefined", () => {
    expect(normalizeScheduledJobExecution({ ...base }, opts).durationMs).toBe(0);
  });

  it("falls back to 0 when durationMs is NaN — `??` does NOT catch NaN, so a corrupt subtraction (Invalid Date startedAt → now-startedAt = NaN) would otherwise persist NaN to the execution log", () => {
    expect(normalizeScheduledJobExecution({ ...base, durationMs: Number.NaN }, opts).durationMs).toBe(0);
  });

  it("falls back to 0 when durationMs is Infinity / -Infinity (defensive against a runaway clock-skew calculation)", () => {
    expect(normalizeScheduledJobExecution({ ...base, durationMs: Number.POSITIVE_INFINITY }, opts).durationMs).toBe(0);
    expect(normalizeScheduledJobExecution({ ...base, durationMs: Number.NEGATIVE_INFINITY }, opts).durationMs).toBe(0);
  });
});
