import { describe, expect, it } from "vitest";

import { trimToolOutput } from "../src/memory-tool-output-trim.js";

const big = "H".repeat(50) + "M".repeat(200) + "T".repeat(50); // 300 chars: head H, middle M, tail T

describe("trimToolOutput — no-op cases (conservative)", () => {
  it("returns the input unchanged when maxChars <= 0 (no cap configured)", () => {
    expect(trimToolOutput("hello", { maxChars: 0 })).toEqual({ output: "hello", truncated: false, originalLength: 5 });
    expect(trimToolOutput("hello", { maxChars: -10 }).truncated).toBe(false);
  });

  it("returns the input unchanged when it already fits the cap (boundary: length === maxChars)", () => {
    expect(trimToolOutput("hello", { maxChars: 100 })).toEqual({ output: "hello", truncated: false, originalLength: 5 });
    // exactly at the cap is still a no-op (the guard is `<=`).
    expect(trimToolOutput("hello", { maxChars: 5 }).truncated).toBe(false);
  });
});

describe("trimToolOutput — head+tail elision", () => {
  it("NEVER exceeds maxChars and preserves the head and tail with an elision marker", () => {
    const r = trimToolOutput(big, { maxChars: 120 });
    expect(r.truncated).toBe(true);
    expect(r.originalLength).toBe(300);
    expect(r.output.length).toBeLessThanOrEqual(120);
    expect(r.output.startsWith("H")).toBe(true); // headline preserved
    expect(r.output.endsWith("T")).toBe(true); // trailing context preserved
    expect(r.output).toContain("[truncated:");
    expect(r.output).toContain("of 300 total"); // original size surfaced for re-fetch decisions
  });

  it("surfaces the optional hint inside the marker", () => {
    const r = trimToolOutput(big, { maxChars: 120, hint: "call read with offset=120 to see more" });
    expect(r.output).toContain("call read with offset=120 to see more");
    expect(r.output.length).toBeLessThanOrEqual(120);
  });

  it("headRatio=0 drops the head entirely but keeps the tail; headRatio still bounds the output", () => {
    const r = trimToolOutput(big, { maxChars: 120, headRatio: 0 });
    expect(r.output.startsWith("H")).toBe(false);
    expect(r.output.endsWith("T")).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(120);
  });

  it("a non-finite or out-of-range headRatio falls back to the 0.7 default (never NaN-poisons the slice)", () => {
    for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, -1, 5]) {
      const r = trimToolOutput(big, { headRatio: ratio, maxChars: 120 });
      expect(r.output.length, `headRatio=${ratio}`).toBeLessThanOrEqual(120);
      expect(r.truncated).toBe(true);
    }
  });

  it("a pathologically tiny budget (smaller than the marker) returns marker-only, still within the cap", () => {
    const r = trimToolOutput(big, { maxChars: 10 });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(10);
  });

  it("is idempotent: a trimmed output that fits the same cap is not trimmed again", () => {
    const once = trimToolOutput(big, { maxChars: 120 });
    const twice = trimToolOutput(once.output, { maxChars: 120 });
    expect(twice.truncated).toBe(false);
    expect(twice.output).toBe(once.output);
  });
});
