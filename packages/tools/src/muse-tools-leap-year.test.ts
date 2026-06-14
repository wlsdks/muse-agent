import { describe, expect, it } from "vitest";

import { createLeapYearTool, isLeapYear } from "./muse-tools-leap-year.js";

describe("isLeapYear (Gregorian: ÷4 except centuries unless ÷400)", () => {
  it("identifies ordinary ÷4 leap years and non-leap years", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2023)).toBe(false);
    expect(isLeapYear(2025)).toBe(false);
  });
  it("applies the century exception — ÷100 is NOT leap unless ÷400", () => {
    expect(isLeapYear(2000)).toBe(true); // ÷400
    expect(isLeapYear(1600)).toBe(true); // ÷400
    expect(isLeapYear(1900)).toBe(false); // ÷100, not ÷400
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2200)).toBe(false);
  });
});

describe("createLeapYearTool", () => {
  it("is a read tool named leap_year", () => {
    const tool = createLeapYearTool();
    expect(tool.definition.name).toBe("leap_year");
    expect(tool.definition.risk).toBe("read");
  });
  it("reports whether a year is a leap year", () => {
    const out = createLeapYearTool().execute({ year: 2024 }, { runId: "r", userId: "u" }) as { leap: boolean };
    expect(out.leap).toBe(true);
  });
});
