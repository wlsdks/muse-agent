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
