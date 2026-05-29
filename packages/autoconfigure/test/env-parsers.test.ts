import { describe, expect, it } from "vitest";

import {
  parseBoolean,
  parseBooleanTriState,
  parseCsv,
  parseInteger,
  parseNonNegativeFloat,
  parseNonNegativeInteger,
  parseOptionalString,
  parsePositiveFloat,
  parseSloErrorRate,
} from "../src/env-parsers.js";

describe("parseBoolean", () => {
  it("returns the fallback when unset", () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean(undefined, false)).toBe(false);
  });

  it("matches the eight standard spellings case-insensitively, whitespace-trimmed", () => {
    for (const v of ["true", "1", "yes", "on", "  TRUE  ", "On", "YES"]) {
      expect(parseBoolean(v, false)).toBe(true);
    }
    for (const v of ["false", "0", "no", "off", "  FALSE ", "Off", "NO"]) {
      expect(parseBoolean(v, true)).toBe(false);
    }
  });

  it("preserves the caller's fallback on an unrecognised value (typo must not coerce to false)", () => {
    expect(parseBoolean("Treu", true)).toBe(true);
    expect(parseBoolean("garbage", false)).toBe(false);
    expect(parseBoolean("", true)).toBe(true);
  });
});

describe("parseBooleanTriState", () => {
  it("returns undefined for unset / blank / unrecognised, distinguishing it from an explicit value", () => {
    expect(parseBooleanTriState(undefined)).toBeUndefined();
    expect(parseBooleanTriState("")).toBeUndefined();
    expect(parseBooleanTriState("maybe")).toBeUndefined();
  });

  it("returns the boolean for any recognised spelling", () => {
    expect(parseBooleanTriState("ON")).toBe(true);
    expect(parseBooleanTriState("0")).toBe(false);
  });
});

describe("parseInteger (strict positive integer)", () => {
  it("returns the fallback when unset", () => {
    expect(parseInteger(undefined, 42)).toBe(42);
  });

  it("parses a plain trimmed decimal integer", () => {
    expect(parseInteger("60", 10)).toBe(60);
    expect(parseInteger("  7  ", 10)).toBe(7);
    expect(parseInteger("+5", 10)).toBe(5);
  });

  it("rejects trailing-garbage / unit-slip tokens (parseInt leniency) and falls back", () => {
    expect(parseInteger("60x", 10)).toBe(10);
    expect(parseInteger("16k", 10)).toBe(10);
    expect(parseInteger("1.5", 10)).toBe(10);
  });

  it("falls back for non-positive values (contract is > 0)", () => {
    expect(parseInteger("0", 10)).toBe(10);
    expect(parseInteger("-5", 10)).toBe(10);
  });

  it("falls back for integers that lose precision in the double conversion", () => {
    expect(parseInteger("9007199254740993", 10)).toBe(10);
  });
});

describe("parseNonNegativeInteger (honours an explicit 0)", () => {
  it("returns the fallback when unset", () => {
    expect(parseNonNegativeInteger(undefined, 7)).toBe(7);
  });

  it("honours a deliberate 0 instead of coercing to the fallback", () => {
    expect(parseNonNegativeInteger("0", 7)).toBe(0);
  });

  it("falls back for negative and trailing-garbage values", () => {
    expect(parseNonNegativeInteger("-1", 7)).toBe(7);
    expect(parseNonNegativeInteger("3x", 7)).toBe(7);
  });
});

describe("parseSloErrorRate (clamped to [0, 1])", () => {
  it("returns the fallback when unset or out of range", () => {
    expect(parseSloErrorRate(undefined, 0.05)).toBe(0.05);
    expect(parseSloErrorRate("-0.1", 0.05)).toBe(0.05);
    expect(parseSloErrorRate("1.5", 0.05)).toBe(0.05);
  });

  it("accepts the inclusive bounds and interior values", () => {
    expect(parseSloErrorRate("0", 0.05)).toBe(0);
    expect(parseSloErrorRate("1", 0.05)).toBe(1);
    expect(parseSloErrorRate("0.25", 0.05)).toBe(0.25);
  });
});

describe("parsePositiveFloat (> 0)", () => {
  it("returns the fallback when unset, zero, negative, or non-finite", () => {
    expect(parsePositiveFloat(undefined, 2)).toBe(2);
    expect(parsePositiveFloat("0", 2)).toBe(2);
    expect(parsePositiveFloat("-3.5", 2)).toBe(2);
    expect(parsePositiveFloat("Infinity", 2)).toBe(2);
  });

  it("parses a real decimal float", () => {
    expect(parsePositiveFloat("0.5", 2)).toBe(0.5);
    expect(parsePositiveFloat("  1.25 ", 2)).toBe(1.25);
  });

  it("rejects unit-slip / trailing-garbage floats", () => {
    expect(parsePositiveFloat("0.5x", 2)).toBe(2);
    expect(parsePositiveFloat("60s", 2)).toBe(2);
    expect(parsePositiveFloat("", 2)).toBe(2);
  });
});

describe("parseNonNegativeFloat (>= 0)", () => {
  it("honours 0 and parses positive floats, falling back for negatives", () => {
    expect(parseNonNegativeFloat("0", 2)).toBe(0);
    expect(parseNonNegativeFloat("3.5", 2)).toBe(3.5);
    expect(parseNonNegativeFloat("-0.1", 2)).toBe(2);
  });
});

describe("float parsers reject non-decimal numeric notations (strict-reject contract)", () => {
  it("does not silently decode hex / octal / binary literals as Number() would", () => {
    expect(parsePositiveFloat("0x10", 2)).toBe(2);
    expect(parseNonNegativeFloat("0b101", 2)).toBe(2);
    expect(parseSloErrorRate("0x1", 0.05)).toBe(0.05);
  });
});

describe("parseCsv", () => {
  it("returns undefined for unset / empty / all-blank input", () => {
    expect(parseCsv(undefined)).toBeUndefined();
    expect(parseCsv("")).toBeUndefined();
    expect(parseCsv("  , ,  ")).toBeUndefined();
  });

  it("splits, trims, and drops empty entries", () => {
    expect(parseCsv("a, b ,,c")).toEqual(["a", "b", "c"]);
  });
});

describe("parseOptionalString", () => {
  it("returns undefined for unset / blank, trims otherwise", () => {
    expect(parseOptionalString(undefined)).toBeUndefined();
    expect(parseOptionalString("   ")).toBeUndefined();
    expect(parseOptionalString("  hi  ")).toBe("hi");
  });
});
