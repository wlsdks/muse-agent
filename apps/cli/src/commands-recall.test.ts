import { describe, expect, it } from "vitest";

import { RECALL_SOURCE_VALUES, resolveSource } from "./commands-recall.js";

describe("resolveSource (goal 157)", () => {
  it("returns the default 'all' when --source is omitted", () => {
    expect(resolveSource(undefined)).toEqual({ kind: "ok", source: "all" });
  });

  it("treats an empty or whitespace value as 'no flag' → 'all'", () => {
    expect(resolveSource("")).toEqual({ kind: "ok", source: "all" });
    expect(resolveSource("   ")).toEqual({ kind: "ok", source: "all" });
  });

  it("accepts each known value, case-insensitive", () => {
    for (const value of RECALL_SOURCE_VALUES) {
      expect(resolveSource(value)).toEqual({ kind: "ok", source: value });
      expect(resolveSource(value.toUpperCase())).toEqual({ kind: "ok", source: value });
    }
  });

  it("returns 'invalid' for unknown values so the caller can render a typo hint", () => {
    expect(resolveSource("note")).toEqual({ kind: "invalid", input: "note" });
    expect(resolveSource("episode")).toEqual({ kind: "invalid", input: "episode" });
    expect(resolveSource("everything")).toEqual({ kind: "invalid", input: "everything" });
  });

  it("preserves the original raw input on invalid so the caller renders the user's exact typo", () => {
    expect(resolveSource("  Note  ")).toEqual({ kind: "invalid", input: "  Note  " });
  });
});
