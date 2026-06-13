import { describe, expect, it } from "vitest";

import { buildAskConnections, type RecallHit } from "@muse/recall";

describe("buildAskConnections", () => {
  it("merges notes + episodes, keeps only at/above the floor, ranks desc, caps at limit", () => {
    const out = buildAskConnections({
      notes: [{ file: "a.md", score: 0.9, text: "alpha" }, { file: "b.md", score: 0.3, text: "below floor" }],
      episodes: [{ id: "ep1", score: 0.7, summary: "session beta" }],
      minScore: 0.5,
      limit: 4
    });
    expect(out.map((h) => h.ref)).toEqual(["a.md", "ep1"]);
    expect(out[0]!.source).toBe("notes");
    expect(out[1]!.source).toBe("episodes");
  });
  it("respects the limit cap", () => {
    const notes = [0.9, 0.8, 0.7, 0.6, 0.55].map((score, i) => ({ file: `n${i}.md`, score, text: "x" }));
    expect(buildAskConnections({ notes, episodes: [], limit: 2 })).toHaveLength(2);
  });
  it("drops non-finite scores and applies the default floor (0.5)", () => {
    const out = buildAskConnections({
      notes: [{ file: "nan.md", score: Number.NaN, text: "x" }, { file: "low.md", score: 0.4, text: "x" }],
      episodes: []
    });
    expect(out).toHaveLength(0);
  });
});

describe("RecallHit", () => {
  it("is constructible with the expected shape", () => {
    const hit: RecallHit = { source: "notes", ref: "a.md", score: 0.9, snippet: "x" };
    expect(hit.source).toBe("notes");
  });
});
