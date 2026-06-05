import { describe, expect, it } from "vitest";

import { depositCoRecall, emptyTrails, topCoRecalled } from "./recall-trail.js";

const NOW = 1_700_000_000_000;
const day = 86_400_000;

describe("depositCoRecall", () => {
  it("deposits on every unordered pair of co-recalled notes and accumulates on repeat", () => {
    let trails = depositCoRecall(emptyTrails(), ["a.md", "b.md", "c.md"], NOW);
    // 3 notes → 3 edges (a-b, a-c, b-c)
    expect(Object.keys(trails.trails)).toHaveLength(3);
    // recall a+b again → that edge strengthens, the others don't
    trails = depositCoRecall(trails, ["a.md", "b.md"], NOW);
    expect(topCoRecalled(trails, "a.md", NOW)[0]).toEqual({ noteId: "b.md", strength: 2 });
    expect(topCoRecalled(trails, "a.md", NOW).find((p) => p.noteId === "c.md")?.strength).toBe(1);
  });

  it("is a no-op for fewer than two distinct notes (a single hit deposits nothing)", () => {
    expect(depositCoRecall(emptyTrails(), ["a.md"], NOW).trails).toEqual({});
    expect(depositCoRecall(emptyTrails(), ["a.md", "a.md"], NOW).trails).toEqual({}); // deduped
    expect(depositCoRecall(emptyTrails(), [], NOW).trails).toEqual({});
  });

  it("caps a single edge's weight so a hot pair can't dominate forever", () => {
    let trails = emptyTrails();
    for (let i = 0; i < 100; i += 1) trails = depositCoRecall(trails, ["a.md", "b.md"], NOW, { cap: 50 });
    expect(topCoRecalled(trails, "a.md", NOW)[0]!.strength).toBe(50);
  });
});

describe("topCoRecalled — evaporation-weighted partners, strongest first", () => {
  it("decays a trail by its half-life since the last deposit and ranks by current strength", () => {
    const trails = depositCoRecall(depositCoRecall(emptyTrails(), ["a.md", "b.md"], NOW - 30 * day), ["a.md", "c.md"], NOW);
    // a-b: weight 1 deposited 30 days ago, 30-day half-life → ~0.5; a-c: weight 1 now → 1.0
    const partners = topCoRecalled(trails, "a.md", NOW, { halfLifeMs: 30 * day });
    expect(partners.map((p) => p.noteId)).toEqual(["c.md", "b.md"]); // fresher c outranks decayed b
    expect(partners[1]!.strength).toBeCloseTo(0.5, 5);
  });

  it("drops trails that have evaporated below minStrength, and honours the limit", () => {
    const trails = depositCoRecall(emptyTrails(), ["a.md", "b.md"], NOW - 300 * day); // long-decayed
    expect(topCoRecalled(trails, "a.md", NOW, { halfLifeMs: 30 * day, minStrength: 0.05 })).toEqual([]);
    const wide = depositCoRecall(emptyTrails(), ["a.md", "b.md", "c.md", "d.md"], NOW);
    expect(topCoRecalled(wide, "a.md", NOW, { limit: 2 })).toHaveLength(2);
  });
});
