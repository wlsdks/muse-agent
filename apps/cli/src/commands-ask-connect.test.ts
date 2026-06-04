import { describe, expect, it } from "vitest";

import { buildAskConnections, formatGraphLinksSection, selectGraphConnections } from "./commands-ask.js";
import { formatConnectionsSection } from "./commands-today.js";
import { buildNoteLinkGraph } from "./notes-links.js";

describe("buildAskConnections — second-brain footer for `muse ask --connect`", () => {
  it("ranks notes + episodes together, keeps only those at/above the floor, caps the list", () => {
    const hits = buildAskConnections({
      notes: [
        { file: "notes/finance.md", score: 0.82, text: "Q3 ad spend capped at 12k" },
        { file: "notes/weak.md", score: 0.31, text: "barely related" }
      ],
      episodes: [{ id: "ep_1", score: 0.61, summary: "we agreed to cut the Q3 budget" }],
      limit: 4
    });
    expect(hits.map((h) => h.ref)).toEqual(["notes/finance.md", "ep_1"]); // weak.md (<0.5) dropped, sorted desc
    expect(hits[0]?.source).toBe("notes");
    expect(hits[1]?.source).toBe("episodes");
  });

  it("respects the limit", () => {
    const notes = Array.from({ length: 10 }, (_v, i) => ({ file: `notes/${i.toString()}.md`, score: 0.9 - i * 0.01, text: "x" }));
    expect(buildAskConnections({ notes, episodes: [], limit: 3 })).toHaveLength(3);
  });

  it("returns nothing when no hit clears the floor (no noisy footer)", () => {
    const hits = buildAskConnections({
      notes: [{ file: "notes/a.md", score: 0.2, text: "weak" }],
      episodes: [{ id: "ep", score: 0.1, summary: "weaker" }]
    });
    expect(hits).toHaveLength(0);
    expect(formatConnectionsSection(hits)).toBe(""); // formatter yields empty section
  });

  it("drops non-finite scores", () => {
    const hits = buildAskConnections({
      notes: [{ file: "notes/a.md", score: Number.NaN, text: "x" }, { file: "notes/b.md", score: 0.7, text: "y" }],
      episodes: []
    });
    expect(hits.map((h) => h.ref)).toEqual(["notes/b.md"]);
  });

  it("formats into a scannable '💡 Related in your brain' block", () => {
    const section = formatConnectionsSection(buildAskConnections({
      notes: [{ file: "notes/finance.md", score: 0.82, text: "Q3 ad spend capped at 12k" }],
      episodes: []
    }));
    expect(section).toContain("💡 Related in your brain");
    expect(section).toContain("finance.md");
    expect(section).toContain("Q3 ad spend");
  });
});

describe("selectGraphConnections — explicit [[wiki-link]] neighbours of the grounded note (--connect)", () => {
  // health → links to nutrition + sleep; running backlinks to health (links to it).
  const graph = buildNoteLinkGraph([
    { id: "health.md", body: "See [[nutrition]] and [[sleep]] for details." },
    { id: "nutrition.md", body: "Protein targets." },
    { id: "sleep.md", body: "8 hours." },
    { id: "running.md", body: "Cardio supports [[health]]." },
    { id: "unrelated.md", body: "No links here." }
  ]);

  it("returns the grounded note's resolved outbound links AND its backlinks, excluding itself", () => {
    const links = selectGraphConnections(graph, ["health.md"]);
    // outbound nutrition + sleep (resolved), backlink running — health itself excluded.
    expect(links.sort()).toEqual(["nutrition.md", "running.md", "sleep.md"]);
    expect(links).not.toContain("health.md");
  });

  it("resolves a grounded file by basename too, and dedups across multiple grounded notes", () => {
    // grounded on BOTH health and running → their union of neighbours, deduped,
    // and neither grounded note listed as the other's connection.
    const links = selectGraphConnections(graph, ["notes/health.md", "running.md"]);
    expect(links).toContain("nutrition.md");
    expect(links).toContain("sleep.md");
    expect(links).not.toContain("health.md"); // grounded → excluded
    expect(links).not.toContain("running.md"); // grounded → excluded
    expect(new Set(links).size).toBe(links.length); // no dups
  });

  it("yields nothing for a note with no links, an unknown file, or ad-hoc sources", () => {
    expect(selectGraphConnections(graph, ["unrelated.md"])).toEqual([]);
    expect(selectGraphConnections(graph, ["does-not-exist.md"])).toEqual([]);
    expect(selectGraphConnections(graph, ["clipboard", "https://example.com"])).toEqual([]);
  });

  it("respects the cap", () => {
    expect(selectGraphConnections(graph, ["health.md"], 1)).toHaveLength(1);
  });

  it("formatGraphLinksSection renders a scannable block, empty when no links", () => {
    expect(formatGraphLinksSection([])).toBe("");
    const section = formatGraphLinksSection(["nutrition.md", "sleep.md"]);
    expect(section).toContain("🔗 Linked notes");
    expect(section).toContain("↔ nutrition.md");
    expect(section).toContain("↔ sleep.md");
  });
});
