import { describe, expect, it } from "vitest";

import {
  cosineSimilarityVector,
  formatVectorLiteral,
  InMemoryConversationSummaryStore,
  parseVectorLiteral
} from "../src/memory-conversation-summary-store.js";

describe("vector literal helpers", () => {
  it("round-trips an embedding through format + parse", () => {
    const original = [0.1, -0.25, 0.5, 1e-7];
    const literal = formatVectorLiteral(original);
    expect(literal.startsWith("[")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
    const parsed = parseVectorLiteral(literal);
    expect(parsed).toBeDefined();
    expect(parsed?.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(parsed?.[i] ?? 0).toBeCloseTo(original[i] ?? 0, 6);
    }
  });

  it("parseVectorLiteral handles array input directly", () => {
    expect(parseVectorLiteral([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("parseVectorLiteral returns undefined for non-vector input", () => {
    expect(parseVectorLiteral(undefined)).toBeUndefined();
    expect(parseVectorLiteral("")).toBeUndefined();
    expect(parseVectorLiteral("not a vector")).toBeUndefined();
  });

  it("formatVectorLiteral coerces non-finite to 0", () => {
    expect(formatVectorLiteral([1, Number.NaN, 3])).toBe("[1,0,3]");
  });
});

describe("cosineSimilarityVector", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarityVector([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarityVector([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 for mismatched-length input", () => {
    expect(cosineSimilarityVector([1, 0, 0], [1, 0])).toBe(0);
  });
});

describe("InMemoryConversationSummaryStore.findSimilar", () => {
  it("returns top-K similar summaries by cosine", async () => {
    const store = new InMemoryConversationSummaryStore({ now: () => new Date("2026-05-11T00:00:00Z") });
    await store.save({ embedding: [1, 0, 0], narrative: "alpha", sessionId: "s-1", summarizedUpToIndex: 0, userId: "u1" });
    await store.save({ embedding: [0.9, 0.1, 0], narrative: "beta", sessionId: "s-2", summarizedUpToIndex: 0, userId: "u1" });
    await store.save({ embedding: [0, 1, 0], narrative: "gamma", sessionId: "s-3", summarizedUpToIndex: 0, userId: "u1" });
    const results = await store.findSimilar([1, 0, 0], { topK: 2, userId: "u1" });
    expect(results).toHaveLength(2);
    expect(results[0]?.summary.sessionId).toBe("s-1");
    expect(results[1]?.summary.sessionId).toBe("s-2");
  });

  it("filters by userId", async () => {
    const store = new InMemoryConversationSummaryStore();
    await store.save({ embedding: [1, 0, 0], narrative: "alpha", sessionId: "s-a", summarizedUpToIndex: 0, userId: "u1" });
    await store.save({ embedding: [1, 0, 0], narrative: "beta", sessionId: "s-b", summarizedUpToIndex: 0, userId: "u2" });
    const results = await store.findSimilar([1, 0, 0], { userId: "u1" });
    expect(results).toHaveLength(1);
    expect(results[0]?.summary.sessionId).toBe("s-a");
  });

  it("respects minScore filter", async () => {
    const store = new InMemoryConversationSummaryStore();
    await store.save({ embedding: [1, 0, 0], narrative: "alpha", sessionId: "s-1", summarizedUpToIndex: 0 });
    await store.save({ embedding: [0, 1, 0], narrative: "beta", sessionId: "s-2", summarizedUpToIndex: 0 });
    const results = await store.findSimilar([1, 0, 0], { minScore: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.summary.sessionId).toBe("s-1");
  });

  it("skips summaries without an embedding", async () => {
    const store = new InMemoryConversationSummaryStore();
    await store.save({ narrative: "alpha", sessionId: "s-1", summarizedUpToIndex: 0 });
    const results = await store.findSimilar([1, 0, 0]);
    expect(results).toHaveLength(0);
  });
});
