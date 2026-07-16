import { describe, expect, it } from "vitest";

import { InMemoryExemplarRetriever, normalizeExemplarTopK } from "./exemplar-retriever.js";

describe("exemplar top-K bounds", () => {
  it("falls back to the three-example context budget for invalid or excessive input", async () => {
    expect(normalizeExemplarTopK(Number.POSITIVE_INFINITY)).toBe(3);
    expect(normalizeExemplarTopK(11)).toBe(3);
    const retriever = new InMemoryExemplarRetriever([
      { body: "one", id: "one", index: 1, scenario: "topic", title: "one" },
      { body: "two", id: "two", index: 2, scenario: "topic", title: "two" },
      { body: "three", id: "three", index: 3, scenario: "topic", title: "three" },
      { body: "four", id: "four", index: 4, scenario: "topic", title: "four" }
    ]);
    const result = await retriever.retrieveTopK("topic", Number.POSITIVE_INFINITY);
    expect(result).toContain("one");
    expect(result).toContain("three");
    expect(result).not.toContain("four");
  });
});
