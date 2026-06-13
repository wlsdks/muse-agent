import { describe, expect, it } from "vitest";

import { detectNumericMismatch } from "./numeric-mismatch.js";
import { reportSentenceGroundedness } from "./sentence-groundedness.js";

describe("detectNumericMismatch — unit swap + magnitude error the token gate misses", () => {
  it("flags a UNIT swap (numeral covered, unit differs): 5 g vs 5 mg", () => {
    expect(detectNumericMismatch("The dose is 5 g.", ["The dose is 5 mg."])).toBe(true);
  });
  it("does NOT flag a matching number+unit", () => {
    expect(detectNumericMismatch("The dose is 5 mg.", ["The dose is 5 mg."])).toBe(false);
  });
  it("flags a ≥3-digit magnitude error absent from evidence (13800 vs 1380)", () => {
    expect(detectNumericMismatch("The MTU is 13800.", ["The MTU is 1380."])).toBe(true);
  });
  it("does NOT flag a matching ≥3-digit number, incl. thousands separators (1,250,000 == 1250000)", () => {
    expect(detectNumericMismatch("The rent is 1250000 KRW.", ["monthly rent 1,250,000 KRW due on the 1st"])).toBe(false);
  });
  it("does NOT flag a small (1-2 digit) absent number (word-form false-positive guard)", () => {
    expect(detectNumericMismatch("The cat is 3 years old.", ["The cat is three years old."])).toBe(false);
  });
  it("does NOT fire on a numeric answer unrelated (low-overlap) to the evidence", () => {
    expect(detectNumericMismatch("The MTU is 9000.", ["The recipe serves 4 people."])).toBe(false);
  });
  it("clears the unit when a different numeral carries it (5 mg vs 5 mg + 10 ml)", () => {
    expect(detectNumericMismatch("The dose is 5 mg.", ["The dose is 5 mg and add 10 ml water."])).toBe(false);
  });
});

describe("reportSentenceGroundedness — numeric guard downgrades a unit/magnitude error", () => {
  it("a unit-swapped claim that token-covers is unsupported", () => {
    expect(reportSentenceGroundedness("The dose is 5 g.", ["The dose is 5 mg."]).sentences[0]!.label).toBe("unsupported");
  });
  it("a faithful number+unit claim stays supported", () => {
    expect(reportSentenceGroundedness("The dose is 5 mg.", ["The dose is 5 mg."]).sentences[0]!.label).toBe("supported");
  });
});
