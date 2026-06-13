import { describe, expect, it } from "vitest";

import { allUserMemoryFacts, rankEpisodeHits, renderMemoryFact, selectMemoryFacts } from "@muse/recall";

const NOW = Date.parse("2026-06-13T00:00:00Z");

describe("rankEpisodeHits", () => {
  const episodes = [
    { id: "a", summary: "vpn mtu", embedding: [1, 0, 0] },
    { id: "b", summary: "lunch plans", embedding: [0, 1, 0] }
  ];
  it("ranks by cosine relevance to the query vector", () => {
    const out = rankEpisodeHits([1, 0, 0], episodes, 2, NOW);
    expect(out[0]!.id).toBe("a");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });
  it("returns nothing for a non-positive topK", () => {
    expect(rankEpisodeHits([1, 0, 0], episodes, 0, NOW)).toEqual([]);
  });
  it("gives a recency bump to a more recent episode at equal relevance", () => {
    const eps = [
      { id: "old", summary: "x", embedding: [1, 0, 0], endedAt: "2026-01-01T00:00:00Z" },
      { id: "new", summary: "x", embedding: [1, 0, 0], endedAt: "2026-06-12T00:00:00Z" }
    ];
    expect(rankEpisodeHits([1, 0, 0], eps, 1, NOW)[0]!.id).toBe("new");
  });
});

describe("allUserMemoryFacts", () => {
  it("includes facts + plain preferences but drops veto:/goal: persona slots", () => {
    const facts = allUserMemoryFacts({
      facts: { allergy_penicillin: "yes" },
      preferences: { "favorite_color": "blue", "veto:send": "1", "goal:fitness": "x" }
    });
    const keys = facts.map((f) => f.key);
    expect(keys).toContain("allergy_penicillin");
    expect(keys).toContain("favorite_color");
    expect(keys).not.toContain("veto:send");
    expect(keys).not.toContain("goal:fitness");
  });
});

describe("renderMemoryFact", () => {
  it("renders a boolean-ish fact as the topic alone", () => {
    expect(renderMemoryFact({ key: "allergy_penicillin", value: "yes" })).toBe("allergy penicillin");
  });
  it("keeps a real value", () => {
    expect(renderMemoryFact({ key: "favorite_color", value: "blue" })).toBe("favorite color: blue");
  });
});

describe("selectMemoryFacts", () => {
  const memory = { facts: { allergy_penicillin: "yes", car_model: "tesla" }, preferences: {} };
  it("returns the facts overlapping the query tokens", () => {
    const out = selectMemoryFacts(memory, new Set(["penicillin"]));
    expect(out.map((f) => f.key)).toEqual(["allergy_penicillin"]);
  });
  it("returns nothing when the query has no tokens", () => {
    expect(selectMemoryFacts(memory, new Set())).toEqual([]);
  });
});
