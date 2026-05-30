import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  chunkText,
  coerceBoolean,
  coerceNumber,
  coerceStringSet,
  compatEnumString,
  epochMillisOrNull,
  readQueryBoolean,
  readQueryInteger,
  sanitizeFilename,
  stringMapField,
  toJsonObject
} from "./compat-parsers.js";

// Direct coverage for the compat-parsers (untested module) — the untrusted-input
// normalization boundary for the compat API. These turn unknown request data
// into typed values; the strict integer parse (no unit-slip), the JSON-value
// filter, and sanitizeFilename (path-safety) are the load-bearing/security ones.

const req = (query: Record<string, unknown>): FastifyRequest => ({ query }) as unknown as FastifyRequest;

describe("readQueryInteger", () => {
  it("strict-parses, sending a typo'd / unit-slipped value to the fallback (not a silent partial parse)", () => {
    expect(readQueryInteger(req({ limit: "20" }), "limit", 5)).toBe(20);
    expect(readQueryInteger(req({ limit: "20x" }), "limit", 5)).toBe(5); // NOT 20
    expect(readQueryInteger(req({ days: "7d" }), "days", 1)).toBe(1); // NOT 7
    expect(readQueryInteger(req({}), "missing", 9)).toBe(9);
    expect(readQueryInteger(req({ n: "-3" }), "n", 0)).toBe(-3);
  });
});

describe("coerceStringSet", () => {
  it("splits a CSV string and dedups + trims; dedups an array; ignores other types", () => {
    expect(coerceStringSet(" a, b ,a,, c")).toEqual(["a", "b", "c"]);
    expect(coerceStringSet(["x", " x ", "y"])).toEqual(["x", "y"]);
    expect(coerceStringSet(5)).toEqual([]);
  });
});

describe("sanitizeFilename", () => {
  it("replaces path/injection characters with underscores and caps at 100 chars", () => {
    expect(sanitizeFilename("../etc/passwd; rm -rf")).toBe(".._etc_passwd__rm_-rf"); // no slashes/spaces/semicolons survive
    expect(sanitizeFilename("a".repeat(200))).toHaveLength(100);
  });
});

describe("coerceNumber / coerceBoolean", () => {
  it("coerceNumber parses numeric strings and falls back on NaN / non-numeric", () => {
    expect(coerceNumber("3.5", 0)).toBe(3.5);
    expect(coerceNumber("abc", 9)).toBe(9);
    expect(coerceNumber(Number.NaN, 9)).toBe(9);
  });

  it("coerceBoolean accepts 'true'/'1' as true, everything else falls back", () => {
    expect(coerceBoolean("true", false)).toBe(true);
    expect(coerceBoolean("1", false)).toBe(true);
    expect(coerceBoolean("0", true)).toBe(false);
    expect(coerceBoolean(undefined, true)).toBe(true);
  });
});

describe("epochMillisOrNull", () => {
  it("accepts a finite number, a Date, and an ISO string; null for anything unparseable", () => {
    expect(epochMillisOrNull(1_000)).toBe(1_000);
    expect(epochMillisOrNull(new Date(2_000))).toBe(2_000);
    expect(epochMillisOrNull("2026-05-30T00:00:00Z")).toBe(Date.parse("2026-05-30T00:00:00Z"));
    expect(epochMillisOrNull("nope")).toBeNull();
    expect(epochMillisOrNull(null)).toBeNull();
  });
});

describe("toJsonObject / stringMapField", () => {
  it("toJsonObject keeps only JSON-valued entries (drops functions / undefined)", () => {
    expect(toJsonObject({ a: 1, b: () => 1, c: "x", d: undefined })).toEqual({ a: 1, c: "x" });
    expect(toJsonObject(5)).toEqual({});
  });

  it("stringMapField keeps only string→string entries", () => {
    expect(stringMapField({ a: "x", b: 5, c: "y" })).toEqual({ a: "x", c: "y" });
    expect(stringMapField(null)).toEqual({});
  });
});

describe("readQueryBoolean / compatEnumString / chunkText", () => {
  it("readQueryBoolean reads 'true'/'1' and falls back when the key is absent", () => {
    expect(readQueryBoolean(req({ f: "true" }), "f", false)).toBe(true);
    expect(readQueryBoolean(req({}), "f", true)).toBe(true);
  });

  it("compatEnumString trims + uppercases a string, else the fallback", () => {
    expect(compatEnumString("  active ", "X")).toBe("ACTIVE");
    expect(compatEnumString(5, "DEF")).toBe("DEF");
  });

  it("chunkText splits into 2000-char chunks and returns [content] for empty input", () => {
    expect(chunkText("a".repeat(4_500)).map((c) => c.length)).toEqual([2_000, 2_000, 500]);
    expect(chunkText("")).toEqual([""]);
  });
});
