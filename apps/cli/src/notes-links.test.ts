import { describe, expect, it } from "vitest";

import { auditNoteGraph, buildNoteLinkGraph, extractWikiLinks, linkedFromResults, linkExpandRefs, noteLinkKey, noteLinkView, planLinkFixes, resolveNoteId, rewriteWikiLinkReferences } from "./notes-links.js";

describe("planLinkFixes — snap a broken [[link]] to its UNIQUE closest note, never guess an ambiguous one", () => {
  const existing = ["concepts", "journal", "food", "fool"];

  it("fixes a unique typo within the edit-distance budget", () => {
    const { fixes, unresolved } = planLinkFixes(["concpets"], existing);
    expect(fixes).toEqual([{ distance: 2, from: "concpets", to: "concepts" }]);
    expect(unresolved).toEqual([]);
  });

  it("leaves an AMBIGUOUS target unresolved (two notes equally close → never mis-link)", () => {
    const { fixes, unresolved } = planLinkFixes(["foop"], existing); // food & fool both distance 1
    expect(fixes).toEqual([]);
    expect(unresolved).toEqual(["foop"]);
  });

  it("leaves a target with NO close match unresolved, and dedupes repeated targets", () => {
    expect(planLinkFixes(["zzzzzz"], existing).unresolved).toEqual(["zzzzzz"]);
    expect(planLinkFixes(["concpets", "CONCPETS"], existing).fixes).toHaveLength(1); // case-insensitive dedupe
  });

  it("respects maxDistance — a far typo isn't snapped at distance 1", () => {
    expect(planLinkFixes(["concpets"], existing, 1).unresolved).toEqual(["concpets"]); // distance 2 > 1
  });
});

describe("rewriteWikiLinkReferences", () => {
  it("rewrites the target, preserving |alias and #section, matching case-insensitively", () => {
    const body = "See [[ideas]] and [[Ideas|my alias]] and [[ideas#part2]] but not [[other]] or [[ideabank]].";
    const { body: out, count } = rewriteWikiLinkReferences(body, "ideas", "concepts");
    expect(count).toBe(3);
    expect(out).toContain("[[concepts]]");
    expect(out).toContain("[[concepts|my alias]]"); // alias kept
    expect(out).toContain("[[concepts#part2]]"); // section kept
    expect(out).toContain("[[other]]"); // unrelated link untouched
    expect(out).toContain("[[ideabank]]"); // a longer target is NOT a partial match
  });

  it("returns the body unchanged with count 0 when no link matches (or the old target is blank)", () => {
    expect(rewriteWikiLinkReferences("[[a]] [[b]]", "z", "y")).toEqual({ body: "[[a]] [[b]]", count: 0 });
    expect(rewriteWikiLinkReferences("[[a]]", "  ", "y").count).toBe(0);
  });
});

describe("extractWikiLinks", () => {
  it("pulls [[targets]], stripping |alias and #section, deduped order-preserving", () => {
    const body = "See [[Health Log]] and [[health log#sleep]] plus [[Project X|the project]]. Again [[Health Log]].";
    expect(extractWikiLinks(body)).toEqual(["Health Log", "Project X"]);
  });
  it("ignores empty targets and bodies with no links", () => {
    expect(extractWikiLinks("[[]] no real links here")).toEqual([]);
    expect(extractWikiLinks("plain note")).toEqual([]);
  });
});

describe("noteLinkKey", () => {
  it("is the basename without extension, lowercased", () => {
    expect(noteLinkKey("inbox/2026-05-01.md")).toBe("2026-05-01");
    expect(noteLinkKey("Health Log.markdown")).toBe("health log");
    expect(noteLinkKey("plain")).toBe("plain");
  });
});

describe("buildNoteLinkGraph + noteLinkView — backlinks", () => {
  const notes = [
    { id: "a.md", body: "links to [[b]] and [[c]]" },
    { id: "b.md", body: "links back to [[a]]" },
    { id: "c.md", body: "no links" }
  ];

  it("surfaces backlinks (who links to me) and resolves outbound targets", () => {
    const graph = buildNoteLinkGraph(notes);
    const viewC = noteLinkView(graph, "c.md");
    expect(viewC.backlinks).toEqual(["a.md"]); // a links to c
    expect(viewC.outbound).toEqual([]);

    const viewA = noteLinkView(graph, "a.md");
    expect(viewA.backlinks).toEqual(["b.md"]); // b links to a
    expect(viewA.outbound).toEqual([
      { resolvedId: "b.md", target: "b" },
      { resolvedId: "c.md", target: "c" }
    ]);
  });

  it("marks an outbound link to a non-existent note as unresolved", () => {
    const graph = buildNoteLinkGraph([{ id: "a.md", body: "see [[ghost]]" }]);
    expect(noteLinkView(graph, "a.md").outbound).toEqual([{ target: "ghost" }]);
  });

  it("resolves an extension-qualified link [[b.md]] (normalized via noteLinkKey, not raw)", () => {
    // Obsidian-style links often include the .md; the graph must key/look-up by
    // noteLinkKey, or [[b.md]] is wrongly reported broken + b.md as an orphan.
    const graph = buildNoteLinkGraph([
      { id: "a.md", body: "links to [[b.md]]" },
      { id: "b.md", body: "no links" }
    ]);
    expect(noteLinkView(graph, "a.md").outbound).toEqual([{ resolvedId: "b.md", target: "b.md" }]);
    expect(noteLinkView(graph, "b.md").backlinks).toEqual(["a.md"]);
    const audit = auditNoteGraph(graph);
    expect(audit.brokenLinks).toEqual([]);
    expect(audit.orphans).toEqual([]);
    expect(audit.terminals).toEqual(["b.md"]);
  });

  it("resolveNoteId accepts an exact id or a name/stem", () => {
    const graph = buildNoteLinkGraph(notes);
    expect(resolveNoteId(graph, "a.md")).toBe("a.md");
    expect(resolveNoteId(graph, "A")).toBe("a.md"); // stem, case-insensitive
    expect(resolveNoteId(graph, "missing")).toBeUndefined();
  });
});

describe("auditNoteGraph — orphans + broken links (Zettelkasten hygiene)", () => {
  it("flags orphans (no links in or out) and broken links (unresolved targets)", () => {
    const graph = buildNoteLinkGraph([
      { id: "a.md", body: "links to [[b]] and [[ghost]]" }, // ghost is broken
      { id: "b.md", body: "links back to [[a]]" },
      { id: "lonely.md", body: "an island with no links" } // orphan
    ]);
    const audit = auditNoteGraph(graph);
    expect(audit.orphans).toEqual(["lonely.md"]);
    expect(audit.terminals).toEqual([]); // every linked-to note here also links out
    expect(audit.brokenLinks).toEqual([{ source: "a.md", target: "ghost" }]);
  });

  it("a fully-connected corpus has no orphans, terminals, or broken links", () => {
    const graph = buildNoteLinkGraph([
      { id: "a.md", body: "[[b]]" },
      { id: "b.md", body: "[[a]]" }
    ]);
    expect(auditNoteGraph(graph)).toEqual({ brokenLinks: [], orphans: [], terminals: [] });
  });

  it("a note that is only linked TO (no outbound) is a TERMINAL, not an orphan", () => {
    const graph = buildNoteLinkGraph([
      { id: "hub.md", body: "[[leaf]] and [[stub]]" },
      { id: "leaf.md", body: "no outbound links" },   // referenced, dead-end
      { id: "stub.md", body: "also a dead-end" }       // referenced, dead-end
    ]);
    const audit = auditNoteGraph(graph);
    expect(audit.orphans).toEqual([]);                  // both have a backlink → not orphans
    expect(audit.terminals).toEqual(["leaf.md", "stub.md"]); // referenced stubs worth expanding (sorted)
  });
});

describe("linkedFromResults — 1-hop graph expansion (GraphRAG)", () => {
  const graph = buildNoteLinkGraph([
    { id: "a.md", body: "see [[b]] and [[c]] and [[ghost]]" },
    { id: "b.md", body: "see [[d]]" },
    { id: "c.md", body: "leaf" },
    { id: "d.md", body: "leaf" }
  ]);

  it("surfaces notes the results link to, resolved, excluding the results themselves", () => {
    // result = a.md → links b, c (and ghost, unresolved → skipped)
    expect(linkedFromResults(["a.md"], graph, 10)).toEqual(["b.md", "c.md"]);
  });

  it("dedupes and excludes notes already in the result set", () => {
    // results a + b; a links b,c,ghost; b links d. b is a result → excluded; ghost unresolved.
    expect(linkedFromResults(["a.md", "b.md"], graph, 10)).toEqual(["c.md", "d.md"]);
  });

  it("respects the cap and handles unknown / non-note refs", () => {
    expect(linkedFromResults(["a.md"], graph, 1)).toEqual(["b.md"]);
    expect(linkedFromResults(["nonexistent.md"], graph, 10)).toEqual([]);
    expect(linkedFromResults(["a.md"], graph, 0)).toEqual([]);
  });

  it("matches results by basename stem (recall refs may be absolute paths)", () => {
    expect(linkedFromResults(["/abs/path/to/a.md"], graph, 10)).toEqual(["b.md", "c.md"]);
  });
});

describe("linkExpandRefs — graph-augmented recall for muse ask", () => {
  const bodies = [
    { id: "apollo.md", body: "Project Apollo status. See [[deadlines]] for the schedule." },
    { id: "deadlines.md", body: "Apollo ships March 15." },
    { id: "recipes.md", body: "carbonara needs guanciale" }
  ];

  it("returns the answer-bearing note 1-hop LINKED from a confident seed", () => {
    // The query matched apollo.md (the seed); the deadline lives in the LINKED
    // deadlines.md, whose own text doesn't mention the query — graph recall finds it.
    expect(linkExpandRefs({ noteBodies: bodies, seedRefs: ["apollo.md"], cap: 2 })).toEqual(["deadlines.md"]);
  });

  it("returns [] when the seed has no outbound links (nothing to expand)", () => {
    expect(linkExpandRefs({ noteBodies: bodies, seedRefs: ["recipes.md"] })).toEqual([]);
  });

  it("returns [] with no seeds or a non-positive cap (conservative)", () => {
    expect(linkExpandRefs({ noteBodies: bodies, seedRefs: [] })).toEqual([]);
    expect(linkExpandRefs({ noteBodies: bodies, seedRefs: ["apollo.md"], cap: 0 })).toEqual([]);
  });
});
