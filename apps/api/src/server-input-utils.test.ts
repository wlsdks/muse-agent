import { describe, expect, it } from "vitest";

import {
  isJsonObject,
  isJsonValue,
  optionalBoolean,
  optionalNullableString,
  optionalString,
  optionalStringArray,
  parseHistoryLimit,
  parseResponseLocales,
  parseRuntimeSettingType,
  readJsonObject,
  readNumber,
  readString,
  readStringArray
} from "./server-input-utils.js";

// Direct coverage for the generic input shape/coercion helpers (untested) — the
// foundation every API parser builds on. The load-bearing ones: isJsonValue's
// recursive JSON validation (rejects functions / non-finite numbers), the
// read* false-sentinel semantics, and parseHistoryLimit's strict integer parse.

describe("isJsonValue / isJsonObject", () => {
  it("accepts null/boolean/string/finite-number/nested arrays+objects, rejects functions and non-finite numbers", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(1)).toBe(true);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(() => 1)).toBe(false);
    expect(isJsonValue([1, "a"])).toBe(true);
    expect(isJsonValue({ a: [1, { b: 2 }] })).toBe(true);
  });

  it("isJsonObject recurses and rejects a function-valued property or an array", () => {
    expect(isJsonObject({ a: 1, b: { c: "x" } })).toBe(true);
    expect(isJsonObject({ a: () => 1 })).toBe(false);
    expect(isJsonObject([1])).toBe(false);
  });
});

describe("optional* coercers", () => {
  it("return the typed value or undefined (null allowed only by the nullable variant)", () => {
    expect(optionalString(5)).toBeUndefined();
    expect(optionalNullableString(null)).toBeNull();
    expect(optionalBoolean("x")).toBeUndefined();
    expect(optionalStringArray(["a", 1, "b"])).toEqual(["a", "b"]); // non-strings filtered
    expect(optionalStringArray("nope")).toBeUndefined();
  });
});

describe("read* helpers", () => {
  it("readString: fallback when key absent, value when a string, undefined when the wrong type", () => {
    expect(readString({}, "k", "fb")).toBe("fb");
    expect(readString({ k: "v" }, "k")).toBe("v");
    expect(readString({ k: 5 }, "k")).toBeUndefined();
  });

  it("readStringArray / readJsonObject return a FALSE sentinel for an invalid present value, the value when valid, the fallback when absent", () => {
    expect(readStringArray({ k: ["a", 2] }, "k")).toBe(false); // a non-string member → invalid
    expect(readStringArray({ k: ["a"] }, "k")).toEqual(["a"]);
    expect(readStringArray({}, "k", ["d"])).toEqual(["d"]);
    expect(readJsonObject({ k: "notobj" }, "k")).toBe(false);
    expect(readJsonObject({ k: { a: 1 } }, "k")).toEqual({ a: 1 });
  });

  it("readNumber accepts a finite number, else undefined / fallback", () => {
    expect(readNumber({ k: 5 }, "k")).toBe(5);
    expect(readNumber({ k: Number.NaN }, "k")).toBeUndefined();
    expect(readNumber({}, "k", 9)).toBe(9);
  });
});

describe("parseHistoryLimit", () => {
  it("strictly parses a positive integer and clamps to max, rejecting decimals / hex / scientific / zero / missing", () => {
    expect(parseHistoryLimit("20", 100)).toBe(20);
    expect(parseHistoryLimit("500", 100)).toBe(100); // clamped
    expect(parseHistoryLimit("9.5", 100)).toBeUndefined();
    expect(parseHistoryLimit("0x10", 100)).toBeUndefined();
    expect(parseHistoryLimit("1e3", 100)).toBeUndefined();
    expect(parseHistoryLimit("0", 100)).toBeUndefined();
    expect(parseHistoryLimit(undefined, 100)).toBeUndefined();
  });
});

describe("parseResponseLocales / parseRuntimeSettingType", () => {
  it("parseResponseLocales filters to ko/en, dedups, and falls back to [ko, en]", () => {
    expect(parseResponseLocales("en, ko ,en,fr")).toEqual(["en", "ko"]);
    expect(parseResponseLocales("")).toEqual(["ko", "en"]);
    expect(parseResponseLocales("fr,de")).toEqual(["ko", "en"]); // none valid → fallback
  });

  it("parseRuntimeSettingType allow-lists string/number/boolean/json, else undefined", () => {
    expect(parseRuntimeSettingType("JSON")).toBe("json");
    expect(parseRuntimeSettingType("bogus")).toBeUndefined();
  });
});
