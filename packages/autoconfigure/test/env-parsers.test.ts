import { describe, expect, it } from "vitest";

import {
  parseBoolean,
  parseBooleanTriState,
  parseCsv,
  parseHeaderMap,
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

// MUSE_MODEL_EXTRA_HEADERS — the LAN-gateway (LiteLLM / reverse proxy /
// Cloudflare-Access service-token) auth-header surface (DS-22).
describe("parseHeaderMap", () => {
  it("returns undefined for unset / blank input", () => {
    expect(parseHeaderMap(undefined)).toBeUndefined();
    expect(parseHeaderMap("")).toBeUndefined();
    expect(parseHeaderMap("   ")).toBeUndefined();
  });

  it("parses a JSON object of string headers", () => {
    expect(parseHeaderMap('{"X-Gateway-Token":"abc123","X-Team":"muse"}')).toEqual({
      "X-Gateway-Token": "abc123",
      "X-Team": "muse"
    });
  });

  it("falls back to undefined (never throws) on malformed JSON", () => {
    expect(parseHeaderMap("not json")).toBeUndefined();
    expect(parseHeaderMap("{unterminated")).toBeUndefined();
  });

  it("falls back to undefined on a non-object JSON value (array, string, number)", () => {
    expect(parseHeaderMap("[1,2,3]")).toBeUndefined();
    expect(parseHeaderMap('"just a string"')).toBeUndefined();
    expect(parseHeaderMap("42")).toBeUndefined();
    expect(parseHeaderMap("null")).toBeUndefined();
  });

  it("falls back to undefined (rejects the WHOLE map) when any value is non-string", () => {
    expect(parseHeaderMap('{"X-Ok":"fine","X-Bad":123}')).toBeUndefined();
    expect(parseHeaderMap('{"X-Nested":{"a":1}}')).toBeUndefined();
  });

  it("rejects header names and values that HTTP clients would reject", () => {
    expect(parseHeaderMap('{"Bad\\nHeader":"fine"}')).toBeUndefined();
    expect(parseHeaderMap('{"X-Ok":"bad\\r\\nnext"}')).toBeUndefined();
  });

  it("returns undefined for an empty object (no headers to add)", () => {
    expect(parseHeaderMap("{}")).toBeUndefined();
  });
});

// Property-based fuzz (backlog P4/P5 — zero property tests before this). The
// env parsers each carry a hard contract: "None throws — invalid input maps to
// the fallback, so a typo'd MUSE_* var won't abort runtime boot." Example tests
// pin specific known cases; this asserts the INVARIANTS hold over a large
// generated adversarial corpus (unicode, control chars, huge/precision-losing
// ints, hex/octal/sci notation, trailing garbage, very long strings). No new
// dep — a deterministic LCG keeps the corpus reproducible (no Math.random flake).
describe("env-parsers — property fuzz (never-throws + always-valid-or-fallback)", () => {
  const adversarialCorpus = (): string[] => {
    const seeds = [
      "", " ", "\t", "\n", "  \r\n ", "true", "FALSE", "Treu", "yes", "off", "1", "0", "00", "+0", "-0",
      "7", "7x", "x7", "60s", "16k", "0.5", "0.5x", ".5", "5.", "1e3", "1E-3", "0x10", "0o17", "0b101",
      "1_000", "9007199254740993", "99999999999999999999", "-5", "+12", "3.14", "Infinity", "-Infinity",
      "NaN", "1.5e", "e5", ",", "a,b,c", " a , , b ", "   spaced   ", "null", "undefined", "{}", "[]",
      "🙂", "한국어", "\u0000", "\u202e", "1\u00a0000", "  -0.0  ", "1.0000000000000002", "2", "1000000",
      ".", "+.", "-.e", "1.2.3", "0.", "1e999", "-1e999", "  12  ", "0.999999", "1.000001", "0.5\n",
    ];
    // Deterministic LCG to weave seeds into longer adversarial tokens.
    let state = 0x12345678;
    const rand = (n: number): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
    const generated: string[] = [];
    for (let i = 0; i < 240; i += 1) {
      const a = seeds[rand(seeds.length)]!;
      const b = seeds[rand(seeds.length)]!;
      const join = ["", " ", ",", ".", "x", "\t", "-", "e"][rand(8)]!;
      generated.push(rand(3) === 0 ? a.repeat(1 + rand(50)) : `${a}${join}${b}`);
    }
    return [...seeds, ...generated];
  };
  const CORPUS = adversarialCorpus();
  const FB_INT = 7;
  const FB_FLOAT = 0.25;

  it("no parser ever throws on any corpus input (or undefined)", () => {
    for (const input of [...CORPUS, undefined]) {
      expect(() => {
        parseBoolean(input, true);
        parseBooleanTriState(input);
        parseInteger(input, FB_INT);
        parseNonNegativeInteger(input, FB_INT);
        parsePositiveFloat(input, FB_FLOAT);
        parseNonNegativeFloat(input, FB_FLOAT);
        parseSloErrorRate(input, FB_FLOAT);
        parseCsv(input);
        parseOptionalString(input);
        parseHeaderMap(input);
      }).not.toThrow();
    }
  });

  it("boolean parsers return only boolean | (undefined for tri-state)", () => {
    for (const input of CORPUS) {
      expect(typeof parseBoolean(input, true)).toBe("boolean");
      const tri = parseBooleanTriState(input);
      expect(tri === undefined || typeof tri === "boolean").toBe(true);
    }
  });

  it("integer parsers return the fallback OR a safe integer satisfying the predicate", () => {
    for (const input of CORPUS) {
      const pos = parseInteger(input, FB_INT);
      expect(pos === FB_INT || (Number.isSafeInteger(pos) && pos > 0)).toBe(true);
      const nonNeg = parseNonNegativeInteger(input, FB_INT);
      expect(nonNeg === FB_INT || (Number.isSafeInteger(nonNeg) && nonNeg >= 0)).toBe(true);
    }
  });

  it("float parsers return the fallback OR a finite number in range", () => {
    for (const input of CORPUS) {
      const pos = parsePositiveFloat(input, FB_FLOAT);
      expect(pos === FB_FLOAT || (Number.isFinite(pos) && pos > 0)).toBe(true);
      const nonNeg = parseNonNegativeFloat(input, FB_FLOAT);
      expect(nonNeg === FB_FLOAT || (Number.isFinite(nonNeg) && nonNeg >= 0)).toBe(true);
      const slo = parseSloErrorRate(input, FB_FLOAT);
      expect(slo === FB_FLOAT || (Number.isFinite(slo) && slo >= 0 && slo <= 1)).toBe(true);
    }
  });

  it("parseCsv returns undefined OR a non-empty list of non-empty trimmed strings", () => {
    for (const input of CORPUS) {
      const out = parseCsv(input);
      if (out !== undefined) {
        expect(out.length).toBeGreaterThan(0);
        expect(out.every((s) => s.length > 0 && s === s.trim())).toBe(true);
      }
    }
  });

  it("parseOptionalString returns undefined OR a non-empty trimmed string", () => {
    for (const input of CORPUS) {
      const out = parseOptionalString(input);
      if (out !== undefined) {
        expect(out.length).toBeGreaterThan(0);
        expect(out).toBe(out.trim());
      }
    }
  });

  // A direct regression guard for the bugs the parser comments document:
  // lenient Number coercion silently accepting trailing garbage / hex / unit
  // suffixes. These MUST map to the fallback, never a silently-wrong value.
  it("never silently coerces trailing-garbage / hex / unit-suffixed tokens (both int and float → fallback)", () => {
    for (const trap of ["60x", "16k", "0x10", "0o17", "0b101", "60s", "0.5x", "1_000"]) {
      expect(parseInteger(trap, FB_INT)).toBe(FB_INT);
      expect(parsePositiveFloat(trap, FB_FLOAT)).toBe(FB_FLOAT);
    }
  });

  it("parseInteger rejects a precision-losing big int (isSafeInteger guard) — fallback, not a silently-wrong value", () => {
    // The FLOAT parsers legitimately accept this with precision loss (it's a
    // float); only the INTEGER parsers must reject the unsafe magnitude.
    expect(parseInteger("9007199254740993", FB_INT)).toBe(FB_INT);
    expect(parseNonNegativeInteger("9007199254740993", FB_INT)).toBe(FB_INT);
  });
});
