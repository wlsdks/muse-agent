import { describe, expect, it } from "vitest";

import { cleanBlock, compactLines, compactSections } from "../src/prompt-text.js";

describe("cleanBlock", () => {
  it("trims a non-empty string", () => {
    expect(cleanBlock("  hi  ")).toBe("hi");
  });

  it("returns undefined for undefined / empty / whitespace-only", () => {
    expect(cleanBlock(undefined)).toBeUndefined();
    expect(cleanBlock("")).toBeUndefined();
    expect(cleanBlock("   ")).toBeUndefined();
  });
});

describe("compactSections", () => {
  it("trims each section and drops empty/undefined ones", () => {
    expect(compactSections(["  a ", undefined, "", "  ", "b"])).toEqual(["a", "b"]);
  });
});

describe("compactLines", () => {
  it("drops only undefined entries, keeping empty strings as-is", () => {
    expect(compactLines(["a", undefined, "", "b"])).toEqual(["a", "", "b"]);
  });
});
