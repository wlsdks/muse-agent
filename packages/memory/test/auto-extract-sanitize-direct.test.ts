import { describe, expect, it } from "vitest";

import { sanitizeEntries, sanitizeSlotArray } from "../src/memory-auto-extract-sanitize.js";

describe("sanitizeEntries (moved into memory-auto-extract-sanitize)", () => {
  it("normalizes keys, keeps values, and emits [key, value] tuples", () => {
    expect(sanitizeEntries({ "Fav Color": "blue" }, 5, 20, 50)).toEqual([["fav_color", "blue"]]);
  });

  it("rejects an array payload (the typeof-[]==='object' footgun) → no-op", () => {
    expect(sanitizeEntries(["foo", "bar"] as unknown as Record<string, string>, 5, 20, 50)).toEqual([]);
  });

  it("caps the count, drops empty/whitespace values, collapses whitespace, and caps value length", () => {
    expect(sanitizeEntries({ a: "1", b: "2", c: "3" }, 2, 20, 50)).toHaveLength(2);
    expect(sanitizeEntries({ k: "   " }, 5, 20, 50)).toEqual([]);
    expect(sanitizeEntries({ k: "a   b" }, 5, 20, 50)).toEqual([["k", "a b"]]);
    expect(sanitizeEntries({ k: "abcdef" }, 5, 20, 3)).toEqual([["k", "abc"]]);
  });
});

describe("sanitizeSlotArray (moved into memory-auto-extract-sanitize)", () => {
  it("normalizes the id, keeps the value, and preserves an optional scope", () => {
    expect(sanitizeSlotArray([{ id: "My Goal", value: "ship it", scope: "Work" }], 5, 20, 50))
      .toEqual([{ id: "my_goal", value: "ship it", scope: "work" }]);
  });

  it("dedupes by normalized id (first valid occurrence wins) and caps the count", () => {
    const got = sanitizeSlotArray(
      [{ id: "goal", value: "first" }, { id: "goal", value: "second" }, { id: "other", value: "x" }],
      5, 20, 50
    );
    expect(got).toEqual([{ id: "goal", value: "first" }, { id: "other", value: "x" }]);
  });

  it("returns [] for a non-array source or maxCount 0, and drops empty-value entries", () => {
    expect(sanitizeSlotArray(undefined, 5, 20, 50)).toEqual([]);
    expect(sanitizeSlotArray([{ id: "g", value: "x" }], 0, 20, 50)).toEqual([]);
    expect(sanitizeSlotArray([{ id: "g", value: "   " }], 5, 20, 50)).toEqual([]);
  });
});
