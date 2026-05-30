import { describe, expect, it } from "vitest";

import { isJsonObject, isJsonValue, isRecord } from "../src/provider-shared.js";

// isJsonValue / isJsonObject are the recursive JSON-shape guards the provider
// adapters lean on to decide a parsed payload is safe to treat as structured
// output. They were exercised only incidentally (via parseJson callers), so the
// per-type branches — incl. the load-bearing finite-number guard (NaN/Infinity
// are NOT valid JSON) and the recursive array/object descent — went unasserted.
// Mutation-surfaced; pinned here directly.

describe("isJsonValue", () => {
  it("accepts the JSON primitives: null, boolean, string, finite number", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(true)).toBe(true);
    expect(isJsonValue("text")).toBe(true);
    expect(isJsonValue(0)).toBe(true);
    expect(isJsonValue(-3.5)).toBe(true);
  });

  it("rejects a NON-FINITE number — NaN / ±Infinity are not representable JSON", () => {
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("rejects undefined, functions, and symbols (no JSON representation)", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => {})).toBe(false);
    expect(isJsonValue(Symbol("s"))).toBe(false);
  });

  it("descends into arrays — valid throughout passes, a single invalid element fails", () => {
    expect(isJsonValue([1, "a", null, true])).toBe(true);
    expect(isJsonValue([])).toBe(true);
    expect(isJsonValue([1, Number.NaN])).toBe(false); // recursive: the NaN element poisons it
    expect(isJsonValue([1, [2, undefined]])).toBe(false); // nested array, deep invalid
  });

  it("descends into objects — valid values pass, a single invalid value fails", () => {
    expect(isJsonValue({ a: { b: 1 }, c: ["x"] })).toBe(true);
    expect(isJsonValue({ a: Number.NaN })).toBe(false);
    expect(isJsonValue({ a: { b: () => {} } })).toBe(false); // nested object, deep invalid
  });
});

describe("isJsonObject", () => {
  it("accepts a plain record whose every value is a valid JSON value", () => {
    expect(isJsonObject({ a: 1, b: "x", c: [true, null] })).toBe(true);
    expect(isJsonObject({})).toBe(true);
  });

  it("rejects a non-record (array, null, primitive) — only a plain object is a JSON object", () => {
    expect(isJsonObject([1, 2])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject(5)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });

  it("rejects a record carrying a non-finite-number value (recurses through isJsonValue)", () => {
    expect(isJsonObject({ ok: 1, bad: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe("isRecord", () => {
  it("is true only for a plain object — not null, not an array, not a primitive", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(5)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
