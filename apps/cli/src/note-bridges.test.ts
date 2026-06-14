import { describe, expect, it } from "vitest";

import { betweennessCentrality, formatBridges, resolvedAdjacency, selectBridges } from "./note-bridges.js";
import { buildNoteLinkGraph } from "./notes-links.js";

// Build a NoteLinkGraph from {id, body} where body cites [[targets]].
function graphOf(notes: ReadonlyArray<{ id: string; links: readonly string[] }>) {
  return buildNoteLinkGraph(notes.map((n) => ({ id: n.id, body: n.links.map((t) => `[[${t}]]`).join(" ") })));
}

describe("resolvedAdjacency", () => {
  it("is undirected and includes only resolved links", () => {
    const adj = resolvedAdjacency(graphOf([
      { id: "a", links: ["b", "ghost"] },
      { id: "b", links: [] }
    ]));
    expect(adj.get("a")).toEqual(new Set(["b"])); // ghost (unresolved) dropped
    expect(adj.get("b")).toEqual(new Set(["a"])); // back-edge added (undirected)
  });

  it("keeps an isolate as a zero-degree node", () => {
    const adj = resolvedAdjacency(graphOf([{ id: "lonely", links: [] }]));
    expect(adj.get("lonely")).toEqual(new Set());
  });

  it("resolves an extension-qualified [[b.md]] edge (normalized via noteLinkKey, not raw)", () => {
    // Obsidian-style links carry the .md; without noteLinkKey the edge is dropped
    // and the broker between two clusters vanishes from betweenness.
    const adj = resolvedAdjacency(graphOf([
      { id: "a.md", links: ["b.md"] },
      { id: "b.md", links: [] }
    ]));
    expect(adj.get("a.md")).toEqual(new Set(["b.md"]));
    expect(adj.get("b.md")).toEqual(new Set(["a.md"]));
  });
});

describe("betweennessCentrality", () => {
  it("a path a-b-c gives the middle node all the brokerage", () => {
    const cb = betweennessCentrality(resolvedAdjacency(graphOf([
      { id: "a", links: ["b"] },
      { id: "b", links: ["c"] },
      { id: "c", links: [] }
    ])));
    expect(cb.get("b")).toBe(1); // brokers the single a-c pair
    expect(cb.get("a")).toBe(0);
    expect(cb.get("c")).toBe(0);
  });

  it("a clique brokers nothing (every pair is directly linked)", () => {
    const cb = betweennessCentrality(resolvedAdjacency(graphOf([
      { id: "a", links: ["b", "c"] },
      { id: "b", links: ["a", "c"] },
      { id: "c", links: ["a", "b"] }
    ])));
    expect([...cb.values()].every((v) => v === 0)).toBe(true);
  });
});

describe("selectBridges", () => {
  it("surfaces the sole connector of two clusters as the top bridge", () => {
    // Two triangles {a1,a2,a3} and {b1,b2,b3}, joined only through X (a1-X-b1).
    const bridges = selectBridges(graphOf([
      { id: "a1", links: ["a2", "a3", "x"] },
      { id: "a2", links: ["a1", "a3"] },
      { id: "a3", links: ["a1", "a2"] },
      { id: "x", links: ["a1", "b1"] },
      { id: "b1", links: ["b2", "b3", "x"] },
      { id: "b2", links: ["b1", "b3"] },
      { id: "b3", links: ["b1", "b2"] }
    ]));
    expect(bridges[0]?.id).toBe("x"); // the sole inter-cluster connector ranks first
    expect(bridges[0]?.score).toBeGreaterThan(0);
    // a clique-internal leaf with no brokerage never appears
    expect(bridges.some((b) => b.id === "a2")).toBe(false);
  });

  it("returns [] when no note brokers anything (a single clique)", () => {
    expect(selectBridges(graphOf([
      { id: "a", links: ["b", "c"] },
      { id: "b", links: ["a", "c"] },
      { id: "c", links: ["a", "b"] }
    ]))).toEqual([]);
  });

  it("honours the limit", () => {
    const bridges = selectBridges(graphOf([
      { id: "h", links: ["a", "b", "c", "d"] }, // star centre brokers all leaf pairs
      { id: "a", links: ["h"] },
      { id: "b", links: ["h"] },
      { id: "c", links: ["h"] },
      { id: "d", links: ["h"] }
    ]), 1);
    expect(bridges).toHaveLength(1);
    expect(bridges[0]?.id).toBe("h");
  });
});

describe("formatBridges", () => {
  it("renders a ranked list with brokerage + degree", () => {
    const out = formatBridges([{ id: "bridge.md", score: 6, degree: 2 }]);
    expect(out).toContain("Bridge notes");
    expect(out).toContain("bridge.md");
    expect(out).toContain("degree 2");
  });

  it("explains the empty case", () => {
    expect(formatBridges([])).toContain("No bridge notes");
  });
});
