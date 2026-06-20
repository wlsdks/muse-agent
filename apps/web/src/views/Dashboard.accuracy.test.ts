import { describe, expect, it } from "vitest";

import { formatAccuracyPct } from "./Dashboard.js";

describe("formatAccuracyPct — never rounds to a misleading extreme", () => {
  it("a non-perfect accuracy never reads 100%", () => {
    expect(formatAccuracyPct(0.999)).toBe("99%");
  });

  it("a non-zero accuracy never reads 0%", () => {
    expect(formatAccuracyPct(0.004)).toBe("1%");
  });

  it("a true 100% still reads 100%", () => {
    expect(formatAccuracyPct(1)).toBe("100%");
  });

  it("a true 0% still reads 0%", () => {
    expect(formatAccuracyPct(0)).toBe("0%");
  });

  it("an ordinary value rounds normally", () => {
    expect(formatAccuracyPct(0.5)).toBe("50%");
  });

  it("missing data renders an em-dash, not NaN%", () => {
    expect(formatAccuracyPct(undefined)).toBe("—");
  });
});
