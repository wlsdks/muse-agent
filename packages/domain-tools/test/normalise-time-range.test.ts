import { describe, expect, it } from "vitest";

import { normaliseTimeRange } from "../src/loopback-search.js";

describe("normaliseTimeRange", () => {
  it("returns undefined for unset / empty / whitespace input", () => {
    expect(normaliseTimeRange(undefined)).toBeUndefined();
    expect(normaliseTimeRange("")).toBeUndefined();
    expect(normaliseTimeRange("   ")).toBeUndefined();
  });

  it("maps each recognised alias to its canonical range", () => {
    expect(["today", "day", "24h"].map((v) => normaliseTimeRange(v))).toEqual(["day", "day", "day"]);
    expect(["week", "7d"].map((v) => normaliseTimeRange(v))).toEqual(["week", "week"]);
    expect(["month", "30d"].map((v) => normaliseTimeRange(v))).toEqual(["month", "month"]);
    expect(["year", "365d"].map((v) => normaliseTimeRange(v))).toEqual(["year", "year"]);
  });

  it("is case-insensitive and whitespace-trimmed", () => {
    expect(normaliseTimeRange("  WEEK ")).toBe("week");
    expect(normaliseTimeRange("Today")).toBe("day");
  });

  it("returns undefined for an unrecognised range", () => {
    expect(normaliseTimeRange("decade")).toBeUndefined();
    expect(normaliseTimeRange("1d")).toBeUndefined();
    expect(normaliseTimeRange("all")).toBeUndefined();
  });
});
