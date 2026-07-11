import { describe, expect, it } from "vitest";

import { hashQuery, normalizeQueryForHash } from "../src/query-hash.js";

describe("normalizeQueryForHash", () => {
  it("lowercases and collapses internal whitespace, trimming ends", () => {
    expect(normalizeQueryForHash("What's   MY Calendar?")).toBe("what's my calendar?");
    expect(normalizeQueryForHash("  hello\tworld\n")).toBe("hello world");
  });
});

describe("hashQuery", () => {
  it("is deterministic for the same text", () => {
    expect(hashQuery("what's on my calendar today")).toBe(hashQuery("what's on my calendar today"));
  });

  it("collapses case + whitespace differences to the SAME hash", () => {
    expect(hashQuery("Hello   World")).toBe(hashQuery("hello world"));
    expect(hashQuery("  what's my calendar?  ")).toBe(hashQuery("what's my calendar?"));
  });

  it("differs for genuinely different queries", () => {
    expect(hashQuery("what's my calendar")).not.toBe(hashQuery("what's the weather"));
  });

  it("is a short hex string", () => {
    expect(hashQuery("some query text")).toMatch(/^[0-9a-f]{8}$/u);
  });
});
