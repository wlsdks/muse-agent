import { describe, expect, it } from "vitest";

import { detectArithmeticQuery, formatArithmeticResult } from "./arithmetic-query.js";

describe("detectArithmeticQuery — only a PURE calculation short-circuits `muse ask`", () => {
  it("extracts the expression from a framed arithmetic question", () => {
    expect(detectArithmeticQuery("what is 1847 * 2963?")).toBe("1847 * 2963");
    expect(detectArithmeticQuery("What's 2+2")).toBe("2+2");
    expect(detectArithmeticQuery("calculate (1200 + 850) / 2")).toBe("(1200 + 850) / 2");
    expect(detectArithmeticQuery("compute 840000 * 0.18")).toBe("840000 * 0.18");
    expect(detectArithmeticQuery("how much is 15% * 200")).toBe("15% * 200");
    expect(detectArithmeticQuery("  12 / 4 =  ")).toBe("12 / 4"); // trailing "=" and spaces stripped
  });

  it("returns null for a real NOTES question (never hijacks retrieval)", () => {
    expect(detectArithmeticQuery("what is my Q3 budget?")).toBeNull();
    expect(detectArithmeticQuery("what's the launch date?")).toBeNull();
    expect(detectArithmeticQuery("calculate the risk for the project")).toBeNull(); // has letters
    expect(detectArithmeticQuery("what did Sarah say about 5 * 3?")).toBeNull();
  });

  it("returns null for a bare number or lone sign (not a calculation)", () => {
    expect(detectArithmeticQuery("what is 42?")).toBeNull(); // no operator
    expect(detectArithmeticQuery("-5")).toBeNull(); // lone negative, no binary op
    expect(detectArithmeticQuery("3.14")).toBeNull();
    expect(detectArithmeticQuery("")).toBeNull();
  });

  it("rejects an over-long expression (256-char guard)", () => {
    expect(detectArithmeticQuery(`1+${"1+".repeat(200)}1`)).toBeNull();
  });
});

describe("formatArithmeticResult — exact answer, grouped for readability", () => {
  it("groups an integer result with thousands separators", () => {
    expect(formatArithmeticResult("1847 * 2963", 5_472_661)).toBe("1847 * 2963 = 5,472,661");
  });

  it("shows a fractional result without trailing-zero noise", () => {
    expect(formatArithmeticResult("840000 * 0.18", 151_200)).toBe("840000 * 0.18 = 151,200");
    expect(formatArithmeticResult("1 / 8", 0.125)).toBe("1 / 8 = 0.125");
  });
});
