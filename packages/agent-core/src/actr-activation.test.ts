import { describe, expect, it } from "vitest";

import { baseLevelActivation, computeActivationBoost } from "./actr-activation.js";
import { InMemoryEpisodicRecallProvider } from "./episodic-recall.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-10T12:00:00Z");
const daysAgo = (days: number): number => NOW - days * DAY;

describe("baseLevelActivation (Anderson & Schooler 1991)", () => {
  it("spaced repeated access beats a single equally-recent access", () => {
    const spaced = baseLevelActivation([daysAgo(1), daysAgo(7), daysAgo(20)], NOW);
    const single = baseLevelActivation([daysAgo(1)], NOW);
    expect(spaced).toBeGreaterThan(single);
  });

  it("more frequent access beats less frequent at the same recency", () => {
    const frequent = baseLevelActivation([daysAgo(2), daysAgo(3), daysAgo(4)], NOW);
    const rare = baseLevelActivation([daysAgo(2)], NOW);
    expect(frequent).toBeGreaterThan(rare);
  });

  it("decays with age — an old single access scores below a fresh one", () => {
    expect(baseLevelActivation([daysAgo(30)], NOW)).toBeLessThan(baseLevelActivation([daysAgo(1)], NOW));
  });

  it("empty access history yields -Infinity (no activation)", () => {
    expect(baseLevelActivation([], NOW)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("computeActivationBoost", () => {
  it("is bounded by the weight and monotone in activation", () => {
    const high = computeActivationBoost([daysAgo(0.01), daysAgo(1)], NOW, 0.15);
    const low = computeActivationBoost([daysAgo(40)], NOW, 0.15);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(0.15);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(computeActivationBoost([], NOW, 0.15)).toBe(0);
  });
});

describe("episodic recall with access history (ACT-R ranking)", () => {
  it("the spaced-repeatedly-accessed episode outranks the equally-similar one-shot episode", async () => {
    const provider = new InMemoryEpisodicRecallProvider({
      allowAnonymousEpisodes: true,
      episodes: [
        {
          accessTimesIso: [new Date(daysAgo(1)).toISOString()],
          createdAtIso: new Date(daysAgo(30)).toISOString(),
          narrative: "project muse deadline planning discussion",
          sessionId: "one-shot"
        },
        {
          accessTimesIso: [daysAgo(2), daysAgo(9), daysAgo(25)].map((ms) => new Date(ms).toISOString()),
          createdAtIso: new Date(daysAgo(30)).toISOString(),
          narrative: "project muse deadline planning discussion",
          sessionId: "spaced"
        }
      ],
      now: () => NOW
    });
    const result = provider.resolve("muse deadline planning");
    expect(result?.matches[0]?.sessionId).toBe("spaced");
  });
});

describe("approximateActivationBoost (count + window approximation, Petrov 2006)", () => {
  it("more recall hits in the same window beat fewer", async () => {
    const { approximateActivationBoost } = await import("./actr-activation.js");
    const many = approximateActivationBoost({ createdMs: daysAgo(30), hits: 6, lastHitMs: daysAgo(1) }, NOW, 0.15);
    const few = approximateActivationBoost({ createdMs: daysAgo(30), hits: 1, lastHitMs: daysAgo(1) }, NOW, 0.15);
    expect(many).toBeGreaterThan(few);
  });

  it("a recent last hit beats a stale one at the same count", async () => {
    const { approximateActivationBoost } = await import("./actr-activation.js");
    const fresh = approximateActivationBoost({ createdMs: daysAgo(30), hits: 3, lastHitMs: daysAgo(1) }, NOW, 0.15);
    const stale = approximateActivationBoost({ createdMs: daysAgo(30), hits: 3, lastHitMs: daysAgo(25) }, NOW, 0.15);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("bounded by weight and zero on nonsense input", async () => {
    const { approximateActivationBoost } = await import("./actr-activation.js");
    expect(approximateActivationBoost({ createdMs: daysAgo(1), hits: 50, lastHitMs: daysAgo(0.01) }, NOW, 0.15)).toBeLessThanOrEqual(0.15);
    expect(approximateActivationBoost({ createdMs: Number.NaN, hits: 0, lastHitMs: Number.NaN }, NOW, 0.15)).toBe(0);
  });
});

describe("store-backed provider uses recall-hit activation when stats are supplied", () => {
  it("the frequently-recalled episode outranks the equally-similar never-recalled one", async () => {
    const { StoreBackedEpisodicRecallProvider } = await import("./episodic-recall.js");
    const summaries = [
      { createdAt: new Date(daysAgo(30)), narrative: "muse project deadline planning talk", sessionId: "cold" },
      { createdAt: new Date(daysAgo(30)), narrative: "muse project deadline planning talk", sessionId: "hot" }
    ];
    const provider = new StoreBackedEpisodicRecallProvider({
      allowAnonymousEpisodes: true,
      now: () => NOW,
      recallStats: () => new Map([["hot", { hits: 5, lastHitMs: daysAgo(2) }]]),
      store: { listAll: () => summaries }
    });
    const result = await provider.resolve("muse deadline planning");
    expect(result?.matches[0]?.sessionId).toBe("hot");
  });
});
