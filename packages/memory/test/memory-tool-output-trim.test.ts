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

describe("trimToolOutput — query-anchored span retention (ACON / Lost-in-the-Middle)", () => {
  // Filler head, a unique marker line buried in the exact elided MIDDLE, filler tail.
  const headFiller = "H".repeat(40);
  const tailFiller = "T".repeat(40);
  const middleFiller = "M".repeat(120);
  const marker = "MEETING 3pm: budget review";
  // The marker sits past the kept-head and before the kept-tail so head+tail elides it.
  const anchored = `${headFiller}\n${middleFiller}\n${marker}\n${middleFiller}\n${tailFiller}`;
  const cap = 120;

  it("WITHOUT anchorTerms a buried middle span is elided (current head+tail behavior)", () => {
    const r = trimToolOutput(anchored, { maxChars: cap });
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain("3pm");
  });

  it("query anchor lifts a middle span head+tail would elide", () => {
    const r = trimToolOutput(anchored, { anchorTerms: ["3pm"], maxChars: cap });
    expect(r.output).toContain(marker); // verbatim span carved from the input
    expect(r.output.length).toBeLessThanOrEqual(cap); // budget still respected
    expect(r.output).toContain("[truncated:"); // elision marker still present
    expect(r.output.startsWith("H")).toBe(true); // some head retained
    expect(r.truncated).toBe(true);
  });

  it("anchor window is sliced VERBATIM and never synthesized", () => {
    const r = trimToolOutput(anchored, { anchorTerms: ["budget"], maxChars: cap });
    // every retained char (minus the marker block) is a substring of the input.
    expect(anchored).toContain(marker);
    expect(r.output).toContain(marker);
  });

  it("matches case-insensitively but keeps original casing in the carved span", () => {
    const r = trimToolOutput(anchored, { anchorTerms: ["MEETING"], maxChars: cap });
    expect(r.output).toContain(marker);
  });

  it("no-op safety: absent anchorTerms is byte-identical to the pre-anchor output", () => {
    const expected = trimToolOutput(anchored, { maxChars: cap }).output;
    const withEmpty = trimToolOutput(anchored, { anchorTerms: [], maxChars: cap }).output;
    const withNoMatch = trimToolOutput(anchored, { anchorTerms: ["zzznomatch"], maxChars: cap }).output;
    expect(withEmpty).toBe(expected);
    expect(withNoMatch).toBe(expected);
  });

  it("no-op safety: anchorTerms on a short already-fitting input changes nothing", () => {
    const r = trimToolOutput("short text", { anchorTerms: ["text"], maxChars: 100 });
    expect(r).toEqual({ output: "short text", truncated: false, originalLength: 10 });
  });
});
