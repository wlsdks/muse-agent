import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { coerceStringSet, readQueryInteger } from "../src/compat-parsers.js";

function req(query: Record<string, unknown>): FastifyRequest {
  return { query } as unknown as FastifyRequest;
}

describe("readQueryInteger — strict-parses the integer query param", () => {
  it("returns the fallback when the param is absent", () => {
    expect(readQueryInteger(req({}), "limit", 30)).toBe(30);
  });

  it("accepts a plain integer", () => {
    expect(readQueryInteger(req({ limit: "20" }), "limit", 30)).toBe(20);
    expect(readQueryInteger(req({ limit: " 12 " }), "limit", 30)).toBe(12);
    expect(readQueryInteger(req({ offset: "-5" }), "offset", 0)).toBe(-5);
  });

  it("rejects a lenient-prefix typo / unit-slip / decimal / scientific instead of silently accepting (goal 463/469/470 sibling)", () => {
    for (const bad of ["20x", "7d", "abc", "5.9", "1e3", "1_000", " ", "Infinity", "NaN"]) {
      expect(readQueryInteger(req({ limit: bad }), "limit", 30), `"${bad}" must fall through`).toBe(30);
    }
  });

  it("falls back when the value is not a string at all", () => {
    expect(readQueryInteger(req({ limit: 20 }), "limit", 30)).toBe(30);
    expect(readQueryInteger(req({ limit: null }), "limit", 30)).toBe(30);
    expect(readQueryInteger(req({ limit: ["20"] }), "limit", 30)).toBe(30);
  });
});

describe("coerceStringSet — array path matches the csv path on trim semantics", () => {
  it("trims + dedups a csv string input", () => {
    expect(coerceStringSet("alpha, beta ,  alpha ,  ,gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns [] for non-string, non-array input", () => {
    expect(coerceStringSet(undefined)).toEqual([]);
    expect(coerceStringSet(null)).toEqual([]);
    expect(coerceStringSet(42)).toEqual([]);
    expect(coerceStringSet({})).toEqual([]);
  });

  it("trims + dedups an array input — symmetric with the csv path", () => {
    expect(coerceStringSet(["alpha", " beta ", "  alpha  ", " ", "gamma"]))
      .toEqual(["alpha", "beta", "gamma"]);
  });

  it("array path drops non-string entries silently", () => {
    expect(coerceStringSet(["alpha", 42, null, "beta", undefined, "  beta  "]))
      .toEqual(["alpha", "beta"]);
  });
});
