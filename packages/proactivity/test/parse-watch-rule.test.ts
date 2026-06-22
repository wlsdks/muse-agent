import { describe, expect, it } from "vitest";

import { parseWatchRule } from "../src/web-watch.js";

describe("parseWatchRule", () => {
  it("rejects non-plain-object input", () => {
    expect(parseWatchRule(null)).toBeUndefined();
    expect(parseWatchRule(undefined)).toBeUndefined();
    expect(parseWatchRule([1, 2])).toBeUndefined();
    expect(parseWatchRule("appears")).toBeUndefined();
    expect(parseWatchRule(42)).toBeUndefined();
  });

  it("rejects an object with no actionable trigger", () => {
    expect(parseWatchRule({})).toBeUndefined();
    expect(parseWatchRule({ extract: "#price" })).toBeUndefined(); // extract alone is not a trigger
    expect(parseWatchRule({ appears: "" })).toBeUndefined(); // empty string ignored
    expect(parseWatchRule({ onAnyChange: false })).toBeUndefined(); // only `true` arms it
    expect(parseWatchRule({ below: Number.NaN, above: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("keeps the string trigger fields and an accompanying extract selector", () => {
    expect(parseWatchRule({ appears: "sale" })).toEqual({ appears: "sale" });
    expect(parseWatchRule({ disappears: "out of stock" })).toEqual({ disappears: "out of stock" });
    expect(parseWatchRule({ appears: "x", extract: "#p" })).toEqual({ appears: "x", extract: "#p" });
  });

  it("stores caseInsensitive only when explicitly false (true is the default and omitted)", () => {
    expect(parseWatchRule({ appears: "x", caseInsensitive: false })).toEqual({ appears: "x", caseInsensitive: false });
    expect(parseWatchRule({ appears: "x", caseInsensitive: true })).toEqual({ appears: "x" });
  });

  it("arms onAnyChange when true", () => {
    expect(parseWatchRule({ onAnyChange: true })).toEqual({ onAnyChange: true });
  });

  it("keeps finite numeric thresholds including zero, dropping non-finite ones", () => {
    expect(parseWatchRule({ below: 0 })).toEqual({ below: 0 });
    expect(parseWatchRule({ above: 100 })).toEqual({ above: 100 });
    expect(parseWatchRule({ below: 5, above: Number.NaN })).toEqual({ below: 5 });
  });

  it("assembles every recognised field together", () => {
    expect(
      parseWatchRule({ appears: "a", disappears: "b", extract: "e", onAnyChange: true, caseInsensitive: false, below: 1, above: 9 }),
    ).toEqual({ appears: "a", disappears: "b", extract: "e", onAnyChange: true, caseInsensitive: false, below: 1, above: 9 });
  });
});
