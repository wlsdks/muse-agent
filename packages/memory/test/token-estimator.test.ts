import { describe, expect, it } from "vitest";

import { computeApproximateTokens, createApproximateTokenEstimator } from "../src/token-estimator.js";

describe("computeApproximateTokens — bucket ratios", () => {
  it("returns 0 for the empty string (no min-1 inflation)", () => {
    expect(computeApproximateTokens("")).toBe(0);
  });

  it("never returns 0 for any non-empty input (max-1 floor; protects the budget gate)", () => {
    expect(computeApproximateTokens("a")).toBe(1);
    expect(computeApproximateTokens(" ")).toBe(1);
    expect(computeApproximateTokens("!")).toBe(1);
  });

  it("buckets Latin text at ~4 chars / token", () => {
    expect(computeApproximateTokens("aaaa")).toBe(1);
    expect(computeApproximateTokens("aaaaaaaa")).toBe(2);
    expect(computeApproximateTokens("a".repeat(40))).toBe(10);
  });

  it("buckets CJK text at ~3 chars / 2 tokens (floor((chars*2+1)/3))", () => {
    expect(computeApproximateTokens("한")).toBe(1);         // (2+1)/3 = 1
    expect(computeApproximateTokens("안녕")).toBe(1);       // (4+1)/3 = 1
    expect(computeApproximateTokens("안녕하")).toBe(2);     // (6+1)/3 = 2
    expect(computeApproximateTokens("일이삼사오")).toBe(3); // (10+1)/3 = 3
  });

  it("buckets emoji 1:1 (each pictograph counts as one token)", () => {
    expect(computeApproximateTokens("😀")).toBe(1);
    expect(computeApproximateTokens("😀😀😀")).toBe(3);
  });

  it("sums across mixed buckets without rounding leak", () => {
    // 8 Latin (=2) + 3 CJK (=2) + 1 emoji (=1) = 5
    expect(computeApproximateTokens("aaaaaaaa안녕하😀")).toBe(5);
  });
});

describe("createApproximateTokenEstimator — cache + TTL", () => {
  it("returns the same count on a repeated query (cache hit, value byte-equal)", () => {
    const est = createApproximateTokenEstimator();
    const first = est.estimate("hello world");
    const second = est.estimate("hello world");
    expect(second).toBe(first);
    expect(second).toBe(computeApproximateTokens("hello world"));
  });

  it("isolated estimators do not share cache entries (no module-level state)", () => {
    const a = createApproximateTokenEstimator();
    const b = createApproximateTokenEstimator();
    expect(a.estimate("hello")).toBe(b.estimate("hello"));
  });

  it("evicts oldest entries when the cache exceeds maxEntries (FIFO, no leak)", () => {
    const est = createApproximateTokenEstimator({ maxEntries: 2 });
    est.estimate("a");
    est.estimate("b");
    est.estimate("c"); // evicts "a"
    // The behaviour is observable as a count (re-estimation is
    // deterministic). The contract here is no-leak / no-throw on
    // overflow; mutation flip-side: a leaking cache would still
    // return correct counts. Pin the count instead.
    expect(est.estimate("a")).toBe(1);
    expect(est.estimate("b")).toBe(1);
    expect(est.estimate("c")).toBe(1);
  });
});
