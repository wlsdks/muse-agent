import { describe, expect, it } from "vitest";

import { parseGraceHours } from "./commands-auth.js";

describe("parseGraceHours (muse auth rotate-jwt --grace-hours)", () => {
  it("keeps the 24h default for an unset or empty flag", () => {
    expect(parseGraceHours(undefined)).toBe(24);
    expect(parseGraceHours("")).toBe(24);
  });

  it("accepts clean integer and decimal hour values", () => {
    expect(parseGraceHours("24")).toBe(24);
    expect(parseGraceHours("0")).toBe(0);
    expect(parseGraceHours("0.5")).toBe(0.5);
    expect(parseGraceHours("1.5")).toBe(1.5);
    expect(parseGraceHours("  12  ")).toBe(12);
  });

  it("rejects a lenient-prefix typo / unit-slip instead of silently mis-sizing the grace window", () => {
    for (const bad of ["24x", "2d", "30m", "1.5h", "12abc", "abc", "-5", "   ", "NaN", "Infinity", "1e309"]) {
      expect(parseGraceHours(bad), `"${bad}" must not be silently accepted`).toBeUndefined();
    }
  });
});
