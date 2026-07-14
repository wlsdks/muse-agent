import { describe, expect, it } from "vitest";

import { beliefValueTimeline, formatFirstLearned, selectRecentlyForgotten, selectRecentlyLearnedFacts, type BeliefProvenance, type FactProvenance } from "./belief-provenance-store.js";

describe("beliefValueTimeline (the value-change path — deepest show-your-work)", () => {
  const tl = (over: Partial<BeliefProvenance>): BeliefProvenance => ({
    userId: "u",
    key: "home_city",
    kind: "fact",
    value: "Seoul",
    learnedAt: "2026-06-10T00:00:00Z",
    ...over
  });

  it("returns the distinct value changes oldest→newest, collapsing re-confirmations of the same value", () => {
    const out = beliefValueTimeline(
      [
        tl({ value: "Seoul", learnedAt: "2026-06-10T00:00:00Z" }),
        tl({ value: "Seoul", learnedAt: "2026-06-12T00:00:00Z" }),
        tl({ value: "Busan", learnedAt: "2026-06-20T00:00:00Z" })
      ],
      "home_city"
    );
    expect(out).toEqual([
      { value: "Seoul", learnedAt: "2026-06-10T00:00:00Z" },
      { value: "Busan", learnedAt: "2026-06-20T00:00:00Z" }
    ]);
  });

  it("excludes retraction markers (they carry no value)", () => {
    const out = beliefValueTimeline(
      [tl({ value: "Seoul", learnedAt: "2026-06-10T00:00:00Z" }), tl({ value: "", learnedAt: "2026-06-19T00:00:00Z", retraction: true })],
      "home_city"
    );
    expect(out).toEqual([{ value: "Seoul", learnedAt: "2026-06-10T00:00:00Z" }]);
  });

  it("yields a single step for a stable belief", () => {
    expect(beliefValueTimeline([tl({ value: "Busan" })], "home_city")).toHaveLength(1);
  });
});

const bp = (over: Partial<BeliefProvenance>): BeliefProvenance => ({
  userId: "u",
  key: "home_city",
  kind: "fact",
  value: "Busan",
  learnedAt: "2026-06-20T00:00:00Z",
  ...over
});

describe("selectRecentlyForgotten (the FORGETS half of Learns-you)", () => {
  const NOW2 = Date.parse("2026-06-21T00:00:00Z");

  it("returns a key whose NEWEST event is a retraction within the window, cited by date", () => {
    const out = selectRecentlyForgotten(
      [
        bp({ key: "pet", value: "cat", learnedAt: "2026-06-10T00:00:00Z" }),
        bp({ key: "pet", value: "", learnedAt: "2026-06-19T00:00:00Z", retraction: true })
      ],
      { now: NOW2, withinDays: 30 }
    );
    expect(out).toEqual([{ forgottenAt: "2026-06-19T00:00:00Z", key: "pet" }]);
  });

  it("does NOT return a key re-set AFTER a retraction (the newest event wins)", () => {
    const out = selectRecentlyForgotten(
      [
        bp({ key: "pet", learnedAt: "2026-06-18T00:00:00Z", retraction: true }),
        bp({ key: "pet", value: "dog", learnedAt: "2026-06-19T00:00:00Z" })
      ],
      { now: NOW2, withinDays: 30 }
    );
    expect(out).toEqual([]);
  });

  it("excludes a retraction older than the recency window", () => {
    expect(
      selectRecentlyForgotten([bp({ key: "pet", learnedAt: "2026-01-01T00:00:00Z", retraction: true })], { now: NOW2, withinDays: 30 })
    ).toEqual([]);
  });
});

const NOW = Date.parse("2026-06-21T00:00:00Z");

const fp = (over: Partial<FactProvenance>): FactProvenance => ({
  key: "home_city",
  kind: "fact",
  value: "Busan",
  firstSeen: "2026-06-20T00:00:00Z",
  lastConfirmed: "2026-06-20T00:00:00Z",
  confirmCount: 1,
  distinctValueCount: 1,
  source: "auto",
  ...over
});

describe("selectRecentlyLearnedFacts", () => {
  it("returns stable facts first learned within the window, newest-first", () => {
    const out = selectRecentlyLearnedFacts(
      [
        fp({ key: "pet", value: "dog", firstSeen: "2026-06-19T00:00:00Z" }),
        fp({ key: "home_city", value: "Busan", firstSeen: "2026-06-20T00:00:00Z" })
      ],
      { now: NOW, withinDays: 30 }
    );
    expect(out.map((f) => f.key)).toEqual(["home_city", "pet"]);
    expect(out[0]).toMatchObject({ key: "home_city", value: "Busan", firstSeen: "2026-06-20T00:00:00Z" });
  });

  it("excludes a CHANGED / flip-flopping key (distinctValueCount > 1) — that is the supersession/volatile signal, not a first-learning", () => {
    expect(selectRecentlyLearnedFacts([fp({ distinctValueCount: 2 })], { now: NOW, withinDays: 30 })).toEqual([]);
  });

  it("excludes a fact first learned OUTSIDE the recency window", () => {
    expect(selectRecentlyLearnedFacts([fp({ firstSeen: "2026-01-01T00:00:00Z" })], { now: NOW, withinDays: 30 })).toEqual([]);
  });

  it("caps the result count", () => {
    const many = Array.from({ length: 8 }, (_, i) => fp({ key: `k${i.toString()}`, firstSeen: `2026-06-${(10 + i).toString()}T00:00:00Z` }));
    expect(selectRecentlyLearnedFacts(many, { now: NOW, withinDays: 30, maxResults: 3 })).toHaveLength(3);
  });

  it("carries the provenance source through (you-stated vs auto-inferred)", () => {
    const out = selectRecentlyLearnedFacts([fp({ source: "user" })], { now: NOW, withinDays: 30 });
    expect(out[0]?.source).toBe("user");
  });
});

describe("formatFirstLearned (honest attribution: how Muse learned it)", () => {
  const fact = (source: "auto" | "user"): FactProvenance => ({
    key: "home_city",
    kind: "fact",
    value: "Busan",
    firstSeen: "2026-06-20T12:00:00Z",
    source
  });

  it("attributes a USER-stated fact to the user", () => {
    expect(formatFirstLearned(fact("user"))).toBe("home city: Busan (you told me · 2026-06-20)");
  });

  it("attributes an AUTO-inferred fact to Muse's own inference", () => {
    expect(formatFirstLearned(fact("auto"))).toBe("home city: Busan (I noticed · 2026-06-20)");
  });
});
