/**
 * Memp (arXiv 2508.06433) playbook lifecycle tests:
 * Wilson interval, evidence-damped reward, lifecycle actions, and wiring.
 */
import { describe, expect, it } from "vitest";

import {
  clampReward,
  effectiveStrategyReward,
  isAvoidedStrategy,
  isInjectableStrategy,
  planStrategyLifecycle,
  rankPlaybookStrategies,
  wilsonInterval,
  type PlaybookStrategy
} from "../src/index.js";

describe("wilsonInterval", () => {
  it("returns {0,1} for total <= 0", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
    expect(wilsonInterval(5, -1)).toEqual({ lower: 0, upper: 1 });
  });

  it("returns {0,1} for non-finite inputs", () => {
    expect(wilsonInterval(NaN, 10)).toEqual({ lower: 0, upper: 1 });
    expect(wilsonInterval(5, Infinity)).toEqual({ lower: 0, upper: 1 });
  });

  it("all successes → upper near 1", () => {
    const { lower, upper } = wilsonInterval(10, 10);
    expect(upper).toBeGreaterThan(0.7);
    expect(lower).toBeGreaterThan(0.5);
  });

  it("no successes → lower near 0", () => {
    const { lower, upper } = wilsonInterval(0, 10);
    expect(lower).toBeLessThan(0.1);
    expect(upper).toBeLessThan(0.4);
  });

  it("monotonicity: more successes → higher lower bound (same total)", () => {
    const a = wilsonInterval(2, 10);
    const b = wilsonInterval(5, 10);
    const c = wilsonInterval(8, 10);
    expect(b.lower).toBeGreaterThan(a.lower);
    expect(c.lower).toBeGreaterThan(b.lower);
  });

  it("known mid-value: 5/10 interval straddles 0.5", () => {
    const { lower, upper } = wilsonInterval(5, 10);
    expect(lower).toBeLessThan(0.5);
    expect(upper).toBeGreaterThan(0.5);
  });
});

describe("legacy identity (regression) — no tally ⇒ byte-identical outputs", () => {
  const legacyStrategies: PlaybookStrategy[] = [
    { text: "when rescheduling default to next business day", tag: "scheduling", reward: 3 },
    { text: "keep emails under 4 sentences", tag: "email", reward: -4 },
    { text: "neutral strategy", reward: 0 }
  ];

  it("effectiveStrategyReward falls back to clampReward for tally-free entries", () => {
    for (const s of legacyStrategies) {
      expect(effectiveStrategyReward(s)).toBe(clampReward(s.reward));
    }
  });

  it("isAvoidedStrategy identical to legacy floor check for tally-free entries", () => {
    expect(isAvoidedStrategy({ text: "x", reward: -4 })).toBe(true);
    expect(isAvoidedStrategy({ text: "x", reward: -3 })).toBe(false);
    expect(isAvoidedStrategy({ text: "x", reward: 3 })).toBe(false);
  });

  it("isInjectableStrategy identical to legacy for tally-free entries", () => {
    expect(isInjectableStrategy({ text: "x", reward: -4 })).toBe(false);
    expect(isInjectableStrategy({ text: "x", reward: 2 })).toBe(true);
    expect(isInjectableStrategy({ text: "x", probation: true, reward: 2 })).toBe(false);
  });

  it("rankPlaybookStrategies output unchanged for a tally-free bank (order stable)", () => {
    const bank: PlaybookStrategy[] = [
      { text: "reschedule to next business day", tag: "scheduling", reward: 2 },
      { text: "use bullet points for long lists", tag: "formatting", reward: 1 }
    ];
    const result = rankPlaybookStrategies(bank, "rescheduling");
    expect(result[0]?.text).toContain("reschedule");
  });
});

describe("conflation fix — tally distinguishes 5/5 from missing", () => {
  it("5 reinforcements + 5 decays → effectiveReward near 0 (not avoided)", () => {
    const s: PlaybookStrategy = { text: "mixed strategy", reinforcements: 5, decays: 5 };
    const r = effectiveStrategyReward(s);
    expect(r).toBeGreaterThan(-1);
    expect(r).toBeLessThan(1);
    expect(isAvoidedStrategy(s)).toBe(false);
    expect(isInjectableStrategy(s)).toBe(true);
  });
});

describe("confident-bad: 0/8 → deprecate + avoided", () => {
  it("8 decays, 0 reinforcements → deprecated + excluded from ranking", () => {
    const s: PlaybookStrategy = { text: "bad strategy", reinforcements: 0, decays: 8 };
    expect(planStrategyLifecycle(s)).toBe("deprecate");
    expect(isAvoidedStrategy(s)).toBe(true);
    expect(isInjectableStrategy(s)).toBe(false);

    const ranked = rankPlaybookStrategies([s, { text: "good strategy", reward: 2 }], "bad strategy");
    expect(ranked.some((r) => r.text === "bad strategy")).toBe(false);
  });
});

describe("sparse-bad protected: 0/2 → retain (insufficient evidence)", () => {
  it("2 decays, 0 reinforcements → retain, still injectable", () => {
    const s: PlaybookStrategy = { text: "maybe bad", reinforcements: 0, decays: 2 };
    expect(planStrategyLifecycle(s)).toBe("retain");
    expect(isAvoidedStrategy(s)).toBe(false);
    expect(isInjectableStrategy(s)).toBe(true);
  });
});

describe("evidence-gated graduation", () => {
  it("probation + 4/4 reinforcements → graduate + injectable", () => {
    const s: PlaybookStrategy = { text: "good probation strategy", probation: true, reinforcements: 4, decays: 0 };
    expect(planStrategyLifecycle(s)).toBe("graduate");
    expect(isInjectableStrategy(s)).toBe(true);
  });

  it("probation + 1/1 reinforcement → retain (insufficient evidence)", () => {
    const s: PlaybookStrategy = { text: "sparse probation strategy", probation: true, reinforcements: 1, decays: 0 };
    expect(planStrategyLifecycle(s)).toBe("retain");
    expect(isInjectableStrategy(s)).toBe(false);
  });

  it("probation + no tally → retain + non-injectable (legacy behaviour)", () => {
    const s: PlaybookStrategy = { text: "legacy probation strategy", probation: true, reward: 2 };
    expect(planStrategyLifecycle(s)).toBe("retain");
    expect(isInjectableStrategy(s)).toBe(false);
  });
});

describe("ranking integration: confident-good tally outranks neutral legacy entry", () => {
  it("confident-good tally entry ranks above a reward=0 entry with equal text relevance", () => {
    const confident: PlaybookStrategy = { text: "strategy about rescheduling", reinforcements: 8, decays: 0 };
    const neutral: PlaybookStrategy = { text: "strategy about rescheduling" };
    const ranked = rankPlaybookStrategies([neutral, confident], "rescheduling");
    // confident has higher effectiveStrategyReward → should rank first (or equal-ties by index)
    const confidentIdx = ranked.findIndex((s) => s.reinforcements === 8);
    const neutralIdx = ranked.findIndex((s) => s.reinforcements === undefined);
    expect(confidentIdx).toBeLessThan(neutralIdx);
  });
});

describe("garbage tallies → legacy path, no throw", () => {
  const garbage: PlaybookStrategy[] = [
    { text: "a", reinforcements: NaN, decays: 3 },
    { text: "b", reinforcements: -1, decays: 3 },
    { text: "c", reinforcements: Infinity, decays: 3 },
    { text: "d", reinforcements: 3, decays: NaN },
    { text: "e", reinforcements: 1.5, decays: 1 }
  ];

  it("effectiveStrategyReward falls back to clampReward without throwing", () => {
    for (const s of garbage) {
      expect(() => effectiveStrategyReward(s)).not.toThrow();
      expect(effectiveStrategyReward(s)).toBe(clampReward(s.reward));
    }
  });

  it("planStrategyLifecycle returns retain without throwing", () => {
    for (const s of garbage) {
      expect(() => planStrategyLifecycle(s)).not.toThrow();
      expect(planStrategyLifecycle(s)).toBe("retain");
    }
  });
});
