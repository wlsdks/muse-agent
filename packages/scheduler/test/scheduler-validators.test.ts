import { describe, expect, it } from "vitest";

import { SchedulerValidationError } from "../src/scheduler-errors.js";
import {
  requireText,
  validateCronExpression,
  validateExecutionTimeout,
  validateJobName
} from "../src/scheduler-validation.js";

describe("validateCronExpression", () => {
  it("accepts standard 5- and 6-field expressions and @-macros the parser supports", () => {
    expect(() => validateCronExpression("0 0 * * *")).not.toThrow();
    expect(() => validateCronExpression("0 0 * * * *")).not.toThrow();
    expect(() => validateCronExpression("@daily")).not.toThrow();
  });

  it("rejects a wrong field count, an unparseable expression, and an unsupported @-macro", () => {
    expect(() => validateCronExpression("0 0 *")).toThrow(SchedulerValidationError); // 3 fields
    expect(() => validateCronExpression("99 99 * * *")).toThrow(SchedulerValidationError); // 5 fields, out of range
    expect(() => validateCronExpression("@every 5m")).toThrow(SchedulerValidationError); // macro the pinned parser rejects
  });
});

describe("validateJobName", () => {
  it("accepts a non-blank name and rejects a blank / whitespace one", () => {
    expect(() => validateJobName("nightly-report")).not.toThrow();
    expect(() => validateJobName("   ")).toThrow(/must not be blank/);
  });
});

describe("validateExecutionTimeout", () => {
  it("treats undefined and 0 as 'no timeout' (allowed)", () => {
    expect(() => validateExecutionTimeout(undefined)).not.toThrow();
    expect(() => validateExecutionTimeout(0)).not.toThrow();
  });

  it("accepts a value inside [1000, 3_600_000] and rejects out-of-range or non-finite", () => {
    expect(() => validateExecutionTimeout(1_000)).not.toThrow(); // lower bound
    expect(() => validateExecutionTimeout(3_600_000)).not.toThrow(); // upper bound
    expect(() => validateExecutionTimeout(999)).toThrow(SchedulerValidationError); // below min
    expect(() => validateExecutionTimeout(3_600_001)).toThrow(SchedulerValidationError); // above max
    // NaN / Infinity slip past raw < / > comparisons, so the !isFinite guard matters.
    expect(() => validateExecutionTimeout(Number.NaN)).toThrow(SchedulerValidationError);
    expect(() => validateExecutionTimeout(Number.POSITIVE_INFINITY)).toThrow(SchedulerValidationError);
  });
});

describe("requireText", () => {
  it("returns the trimmed string for non-blank input", () => {
    expect(requireText("  hi  ", "needed")).toBe("hi");
  });

  it("throws the given message for blank / null / undefined", () => {
    expect(() => requireText("   ", "field A is required")).toThrow("field A is required");
    expect(() => requireText(null, "field B is required")).toThrow("field B is required");
    expect(() => requireText(undefined, "field C is required")).toThrow("field C is required");
  });
});
