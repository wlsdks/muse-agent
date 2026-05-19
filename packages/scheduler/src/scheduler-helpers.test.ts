import { describe, expect, it } from "vitest";

import { SchedulerValidationError } from "./scheduler-errors.js";
import {
  defaultRetryCount,
  defaultTimezone,
  computeNextRunAt,
  requireText,
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
});

describe("validateRetryConfig", () => {
  it("accepts retryOnFailure=false regardless of maxRetryCount", () => {
    expect(() => validateRetryConfig(false, 0)).not.toThrow();
  });
  it("requires maxRetryCount >= 1 when retryOnFailure=true", () => {
    expect(() => validateRetryConfig(true, 1)).not.toThrow();
    expect(() => validateRetryConfig(true, 0)).toThrow(SchedulerValidationError);
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
