import { describe, expect, it } from "vitest";

import { analyzeBenford, benfordExpected, formatBenford, leadingDigit } from "./benford.js";

describe("leadingDigit — first significant digit of the magnitude", () => {
  it("handles integers, decimals, negatives, and large/small magnitudes", () => {
    expect(leadingDigit(314)).toBe(3);
    expect(leadingDigit(0.0042)).toBe(4);
    expect(leadingDigit(-27)).toBe(2);
    expect(leadingDigit(9_999_999)).toBe(9);
    expect(leadingDigit(1)).toBe(1);
  });

  it("is undefined for 0 and non-finite values", () => {
    expect(leadingDigit(0)).toBeUndefined();
    expect(leadingDigit(Number.NaN)).toBeUndefined();
    expect(leadingDigit(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("benfordExpected — the log law", () => {
  it("gives ~30.1% for 1 and ~4.6% for 9, summing to 1", () => {
    expect(benfordExpected(1)).toBeCloseTo(0.30103, 4);
    expect(benfordExpected(9)).toBeCloseTo(0.04576, 4);
    let sum = 0;
    for (let d = 1; d <= 9; d += 1) sum += benfordExpected(d);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe("analyzeBenford — Nigrini MAD conformity", () => {
  // A Benford-conforming sample: counts proportional to the log law over many values.
  const benfordSample = (): number[] => {
    const out: number[] = [];
    // ~990 values distributed across leading digits per Benford. `d*100 + (k%90)`
    // stays in [d00, d89], so the leading digit is always d however large n is.
    for (let d = 1; d <= 9; d += 1) {
      const n = Math.round(benfordExpected(d) * 990);
      for (let k = 0; k < n; k += 1) out.push(d * 100 + (k % 90));
    }
    return out;
  };

  it("a Benford-conforming column is consistent (low chi-square)", () => {
    const result = analyzeBenford(benfordSample());
    expect(result.conformity).toBe("consistent");
    expect(result.chiSquare).toBeLessThan(15.507);
  });

  it("a column where one digit dominates is a strong deviation, naming the standout", () => {
    const skewed = Array.from({ length: 200 }, (_unused, i) => 700 + (i % 99)); // all lead with 7
    const result = analyzeBenford(skewed);
    expect(result.conformity).toBe("strong-deviation");
    expect(result.chiSquare).toBeGreaterThan(20.09);
    expect(result.mostOverrepresented?.digit).toBe(7);
    expect(result.mostOverrepresented!.observed).toBeGreaterThan(result.mostOverrepresented!.expected);
  });

  it("too few values → insufficient (the test is unreliable below the floor)", () => {
    const result = analyzeBenford([1, 2, 3, 40, 500]);
    expect(result.sampleSize).toBe(5);
    expect(result.conformity).toBe("insufficient");
  });

  it("ignores zeros and non-finite values (no leading significant digit)", () => {
    const result = analyzeBenford([0, 0, Number.NaN, 12, 34]);
    expect(result.sampleSize).toBe(2);
    expect(result.counts[1]).toBe(1); // 12 → 1
    expect(result.counts[3]).toBe(1); // 34 → 3
  });
});

describe("formatBenford", () => {
  it("renders the per-digit table + the conformity verdict + the applicability note", () => {
    const result = analyzeBenford(Array.from({ length: 200 }, (_unused, i) => 700 + (i % 50)));
    const out = formatBenford(result, "amount");
    expect(out).toContain("Benford's-Law check — column 'amount'");
    expect(out).toContain("chi-square:");
    expect(out).toContain("worth a look");
    expect(out).toContain("naturally-occurring"); // the honest-scope note
  });

  it("reports when a column has no numeric values", () => {
    expect(formatBenford(analyzeBenford([]), "amount")).toContain("No numeric values");
  });
});
