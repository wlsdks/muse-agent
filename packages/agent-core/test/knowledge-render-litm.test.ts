import { describe, expect, it } from "vitest";

import { renderKnowledgeMatches } from "../src/index.js";

const m = (source: string, score: number) => ({ source, text: source, score });

describe("renderKnowledgeMatches — Lost-in-the-Middle edge placement (Liu et al. 2023)", () => {
  it("places the strongest passage first and the second-strongest last", () => {
    const out = renderKnowledgeMatches([m("c", 0.7), m("a", 0.9), m("e", 0.5), m("b", 0.8), m("d", 0.6)]);
    const order = out.split("\n").slice(1).map((l) => l.replace(/^— \[(.+?)\].*$/u, "$1"));
    expect(order[0]).toBe("a"); // rank 1 → head
    expect(order[order.length - 1]).toBe("b"); // rank 2 → tail
    expect(order).not.toContain(undefined);
  });

  it("buries the weakest passage in the middle, never at an edge", () => {
    const out = renderKnowledgeMatches([m("a", 0.9), m("b", 0.8), m("c", 0.7), m("d", 0.6), m("e", 0.5)]);
    const order = out.split("\n").slice(1).map((l) => l.replace(/^— \[(.+?)\].*$/u, "$1"));
    expect(order[0]).not.toBe("e");
    expect(order[order.length - 1]).not.toBe("e");
    expect(order).toEqual(["a", "c", "e", "d", "b"]);
  });

  it("still renders the header and one line per match", () => {
    const out = renderKnowledgeMatches([m("only", 0.5)]);
    expect(out).toContain("Relevant passages");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("empty corpus message unchanged", () => {
    expect(renderKnowledgeMatches([])).toBe("No matching passages found in the personal corpus.");
  });
});
