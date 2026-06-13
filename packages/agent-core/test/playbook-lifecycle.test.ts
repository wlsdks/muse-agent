/**
 * Memp (arXiv 2508.06433) playbook lifecycle tests:
 * Wilson interval, evidence-damped reward, lifecycle actions, and wiring.
 */
import { describe, expect, it } from "vitest";

import {
  applyPlaybook,
  clampReward,
  effectiveStrategyReward,
  isAvoidedStrategy,
  isInjectableStrategy,
  isStaleStrategy,
  planStrategyLifecycle,
  PLAYBOOK_STALE_AFTER_DAYS,
  rankPlaybookStrategies,
  wilsonInterval,
  type PlaybookProvider,
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
    // Two strategies with identical text: dedup keeps the higher-composite one (confident).
    // Use slightly different texts so both survive dedup, proving reward-ranking still holds.
    const confident: PlaybookStrategy = { text: "strategy about rescheduling meetings", reinforcements: 8, decays: 0 };
    const neutral: PlaybookStrategy = { text: "strategy about rescheduling tasks" };
    const ranked = rankPlaybookStrategies([neutral, confident], "rescheduling");
    // confident has higher effectiveStrategyReward → should rank first
    const confidentIdx = ranked.findIndex((s) => s.reinforcements === 8);
    const neutralIdx = ranked.findIndex((s) => s.reinforcements === undefined);
    expect(confidentIdx).toBeGreaterThanOrEqual(0);
    expect(neutralIdx).toBeGreaterThanOrEqual(0);
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

// SSGM temporal-decay governance (arXiv:2603.11768) — staleness gate unit tests
describe("isStaleStrategy — SSGM temporal-obsolescence gate (arXiv:2603.11768)", () => {
  const daysAgo = (d: number): string =>
    new Date(Date.now() - d * 86_400_000).toISOString();

  it("stale + sparse (reinforcements:1, lastReinforcedAt 150d ago, nowMs provided) → true", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    expect(isStaleStrategy(s, Date.now())).toBe(true);
  });

  it("same strategy but lastReinforcedAt 10d ago → false (not cold yet)", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(10)
    };
    expect(isStaleStrategy(s, Date.now())).toBe(false);
  });

  it("no lastReinforcedAt → false (never-reinforced exemption: staleness only for evidence that WAS earned then went cold)", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0
    };
    expect(isStaleStrategy(s, Date.now())).toBe(false);
  });

  it("nowMs undefined → false (fail-safe: no clock = cannot measure age)", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    expect(isStaleStrategy(s, undefined)).toBe(false);
  });

  it("deep tally (reinforcements:5, 150d old) → false (depth exemption: accumulated evidence)", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 5,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    expect(isStaleStrategy(s, Date.now())).toBe(false);
  });

  it("deep tally via decays (reinforcements:1, decays:2, 150d old) → false (tally ≥ 3)", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 2,
      lastReinforcedAt: daysAgo(150)
    };
    expect(isStaleStrategy(s, Date.now())).toBe(false);
  });

  it("garbage lastReinforcedAt → false (no throw, fail-safe)", () => {
    const s: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: "not-a-date"
    };
    expect(() => isStaleStrategy(s, Date.now())).not.toThrow();
    expect(isStaleStrategy(s, Date.now())).toBe(false);
  });

  it("age exactly at threshold → false (boundary: ≤ PLAYBOOK_STALE_AFTER_DAYS is not stale)", () => {
    // Pin ONE clock for both the anchor and nowMs: deriving the anchor from a
    // first Date.now() and asserting against a second leaves ageDays = 120 + ε,
    // which is > the threshold and (correctly) stale — a racy test, not a bug.
    const now = Date.now();
    const s: PlaybookStrategy = {
      text: "boundary test",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: new Date(now - PLAYBOOK_STALE_AFTER_DAYS * 86_400_000).toISOString()
    };
    expect(isStaleStrategy(s, now)).toBe(false);
  });
});

// SSGM rankEligible integration — staleness gate applied at eligibility stage
describe("isStaleStrategy — rankEligible integration (eligibility-membership filter, not rank score)", () => {
  const daysAgo = (d: number): string =>
    new Date(Date.now() - d * 86_400_000).toISOString();

  it("a stale-sparse strategy is filtered OUT of the ranked set", () => {
    const stale: PlaybookStrategy = {
      text: "stale sparse strategy about summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    const fresh: PlaybookStrategy = {
      text: "fresh strategy about summaries"
    };
    const out = rankPlaybookStrategies([stale, fresh], "summaries", { topK: 6 }, Date.now());
    expect(out.map((s) => s.text)).not.toContain(stale.text);
    expect(out.map((s) => s.text)).toContain(fresh.text);
  });

  it("a fresh relevant strategy is kept even when a stale one is dropped (selective, not blanket)", () => {
    const stale: PlaybookStrategy = {
      text: "stale note about rescheduling tasks",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(200)
    };
    const fresh: PlaybookStrategy = {
      text: "reschedule tasks to the next business day"
    };
    const out = rankPlaybookStrategies([stale, fresh], "rescheduling tasks", { topK: 6 }, Date.now());
    expect(out.some((s) => s.text === stale.text)).toBe(false);
    expect(out.some((s) => s.text === fresh.text)).toBe(true);
  });

  it("without nowMs the stale strategy is NOT filtered (legacy-identical: fail-safe)", () => {
    const stale: PlaybookStrategy = {
      text: "stale sparse strategy about summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    const out = rankPlaybookStrategies([stale], "summaries", { topK: 6 });
    expect(out.map((s) => s.text)).toContain(stale.text);
  });
});

// SSGM assembled-path: applyPlaybook real-revert proves the gate is wired end-to-end
describe("isStaleStrategy — assembled applyPlaybook path (SSGM gate end-to-end)", () => {
  const daysAgo = (d: number): string =>
    new Date(Date.now() - d * 86_400_000).toISOString();

  function ctx(messages: { role: "user" | "assistant" | "system"; content: string }[], userId?: string) {
    return {
      input: { messages, metadata: userId ? { userId } : undefined, model: "test/model" },
      runId: "r",
      startedAt: new Date()
    };
  }

  it("stale-sparse strategy is OMITTED from [Learned Strategies] block; fresh strategy is KEPT", async () => {
    const staleStrategy: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    const freshStrategy: PlaybookStrategy = {
      text: "keep replies warm and brief for everyday requests"
    };

    const provider: PlaybookProvider = {
      listStrategies: async () => [staleStrategy, freshStrategy]
    };

    const out = await applyPlaybook(
      ctx([{ role: "user", content: "please summarise this for everyday use" }], "stark"),
      provider
    );

    const system = out.messages.find((m) => m.role === "system")?.content ?? "";

    // The stale strategy must be absent — the gate excluded it
    expect(system).not.toContain("use bullet points for summaries");
    // The fresh strategy is still present
    expect(system).toContain("keep replies warm and brief");
    // playbookApplied is true (the fresh strategy injected successfully)
    expect(out.metadata?.playbookApplied).toBe(true);
  });

  it("WITHOUT the gate (nowMs absent / legacy path) the stale strategy WOULD appear — proving the gate is the delta", () => {
    // rankPlaybookStrategies without nowMs does not apply the staleness gate
    const staleStrategy: PlaybookStrategy = {
      text: "use bullet points for summaries",
      reinforcements: 1,
      decays: 0,
      lastReinforcedAt: daysAgo(150)
    };
    const freshStrategy: PlaybookStrategy = {
      text: "keep replies warm and brief"
    };

    const withoutGate = rankPlaybookStrategies([staleStrategy, freshStrategy], "summaries", { topK: 6 });
    expect(withoutGate.map((s) => s.text)).toContain("use bullet points for summaries");

    const withGate = rankPlaybookStrategies([staleStrategy, freshStrategy], "summaries", { topK: 6 }, Date.now());
    expect(withGate.map((s) => s.text)).not.toContain("use bullet points for summaries");
    expect(withGate.map((s) => s.text)).toContain("keep replies warm and brief");
  });
});
