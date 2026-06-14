import { describe, expect, it } from "vitest";

import { convertUnit, createUnitConvertTool } from "./muse-tools-units.js";

describe("convertUnit", () => {
  it("converts length across the metric/imperial boundary with exact factors", () => {
    expect(convertUnit(5, "mi", "km")).toBeCloseTo(8.04672, 5);
    expect(convertUnit(1, "m", "cm")).toBeCloseTo(100, 9);
    expect(convertUnit(12, "in", "cm")).toBeCloseTo(30.48, 9);
  });

  it("converts mass", () => {
    expect(convertUnit(1, "kg", "lb")).toBeCloseTo(2.2046226, 6);
    expect(convertUnit(16, "oz", "lb")).toBeCloseTo(1, 9);
  });

  it("converts volume", () => {
    expect(convertUnit(1, "gal", "l")).toBeCloseTo(3.785411784, 9);
  });

  it("converts speed (km/h ↔ mph ↔ m/s)", () => {
    expect(convertUnit(100, "km/h", "mph")).toBeCloseTo(62.137119, 5);
    expect(convertUnit(60, "mph", "km/h")).toBeCloseTo(96.56064, 5);
    expect(convertUnit(10, "m/s", "km/h")).toBeCloseTo(36, 9);
  });

  it("converts time durations (min ↔ h ↔ day ↔ week)", () => {
    expect(convertUnit(90, "min", "h")).toBeCloseTo(1.5, 9);
    expect(convertUnit(2, "day", "h")).toBeCloseTo(48, 9);
    expect(convertUnit(1, "week", "day")).toBeCloseTo(7, 9);
    expect(convertUnit(1.5, "hours", "minutes")).toBeCloseTo(90, 9);
  });

  it("converts area, including the Korean 평 (pyeong)", () => {
    expect(convertUnit(1, "ha", "m2")).toBeCloseTo(10000, 6);
    expect(convertUnit(1, "acre", "m2")).toBeCloseTo(4046.8564224, 6);
    expect(convertUnit(100, "m2", "ft2")).toBeCloseTo(1076.391041671, 6);
    expect(convertUnit(30, "평", "m2")).toBeCloseTo(99.17355372, 6); // 30 × 400/121
    expect(convertUnit(99.17355372, "m2", "평")).toBeCloseTo(30, 6);
  });

  it("converts temperature with the OFFSET (not a pure factor)", () => {
    expect(convertUnit(0, "c", "f")).toBeCloseTo(32, 9);
    expect(convertUnit(100, "c", "f")).toBeCloseTo(212, 9);
    expect(convertUnit(32, "f", "c")).toBeCloseTo(0, 9);
    expect(convertUnit(0, "c", "k")).toBeCloseTo(273.15, 9);
    expect(convertUnit(212, "f", "k")).toBeCloseTo(373.15, 6);
  });

  it("accepts full unit names + plurals", () => {
    expect(convertUnit(2, "kilometers", "meters")).toBeCloseTo(2000, 6);
    expect(convertUnit(0, "celsius", "fahrenheit")).toBeCloseTo(32, 9);
  });

  it("throws on a cross-category conversion (length → mass)", () => {
    expect(() => convertUnit(5, "km", "kg")).toThrow();
  });

  it("throws on temperature ↔ non-temperature", () => {
    expect(() => convertUnit(5, "c", "km")).toThrow();
  });

  it("throws on an unknown unit", () => {
    expect(() => convertUnit(5, "km", "furlong")).toThrow();
  });
});

describe("createUnitConvertTool", () => {
  it("is a read-risk tool named unit_convert that returns the converted value", () => {
    const tool = createUnitConvertTool();
    expect(tool.definition.name).toBe("unit_convert");
    expect(tool.definition.risk).toBe("read");
    const out = tool.execute({ from: "mi", to: "km", value: 5 }, { runId: "t", userId: "u" }) as { value: number };
    expect(out.value).toBeCloseTo(8.04672, 5);
  });

  it("returns an error object (never throws) for incompatible units", () => {
    const tool = createUnitConvertTool();
    const out = tool.execute({ from: "km", to: "kg", value: 5 }, { runId: "t", userId: "u" }) as { error?: string };
    expect(out.error).toBeTruthy();
  });

  it("returns an error for a missing/invalid value", () => {
    const tool = createUnitConvertTool();
    const out = tool.execute({ from: "km", to: "m" }, { runId: "t", userId: "u" }) as { error?: string };
    expect(out.error).toBeTruthy();
  });
});
