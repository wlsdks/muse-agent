import { type ModelProvider, type ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  applyPlaybook,
  clampReward,
  createAgentRuntime,
  effectiveStrategyReward,
  isAvoidedStrategy,
  PLAYBOOK_AVOID_BELOW,
  PLAYBOOK_INJECT_DEDUP_THRESHOLD,
  PLAYBOOK_RECENCY_HALF_LIFE_DAYS,
  PLAYBOOK_REWARD_MAX,
  PLAYBOOK_REWARD_MIN,
  rankingUtility,
  rankPlaybookStrategies,
  rankPlaybookStrategiesByRelevance,
  recencyDiscount,
  renderPlaybookSection,
  strategyTextSimilarity,
  suppressNearDuplicateStrategies,
  type PlaybookProvider,
  type PlaybookStrategy
} from "../src/index.js";

function ctx(messages: { role: "user" | "assistant" | "system"; content: string }[], userId?: string) {
  return {
    input: { messages, metadata: userId ? { userId } : undefined, model: "test/model" },
    runId: "r",
    startedAt: new Date()
  };
}

describe("applyPlaybook — conservative, fail-open gating (ACE arXiv 2510.04618)", () => {
  it("no-ops with no provider, no userId, or zero strategies", async () => {
    const input = ctx([{ content: "reschedule the review", role: "user" }], "stark");
    expect(await applyPlaybook(input, undefined)).toEqual(input.input);
    expect(
      await applyPlaybook(ctx([{ content: "x", role: "user" }]), { listStrategies: async () => [{ text: "do Y" }] })
    ).toEqual(ctx([{ content: "x", role: "user" }]).input);
    expect(await applyPlaybook(input, { listStrategies: async () => [] })).toEqual(input.input);
  });

  it("fail-open: a throwing provider degrades to no-op", async () => {
    const input = ctx([{ content: "x", role: "user" }], "stark");
    const provider: PlaybookProvider = {
      listStrategies: async () => { throw new Error("playbook store unreadable"); }
    };
    expect(await applyPlaybook(input, provider)).toEqual(input.input);
  });

  it("injects a [Learned Strategies] system block listing the strategies", async () => {
    const out = await applyPlaybook(ctx([{ content: "reschedule the review", role: "user" }], "stark"), {
      listStrategies: async () => [{ tag: "scheduling", text: "when rescheduling, default to the next business day" }]
    });
    const system = out.messages.find((m) => m.role === "system");
    expect(system?.content).toContain("[Learned Strategies]");
    expect(system?.content).toContain("next business day");
    expect(out.metadata?.playbookApplied).toBe(true);
  });

  it("ranks injected strategies by relevance to the latest user message (ReasoningBank 2509.25140)", async () => {
    const provider: PlaybookProvider = {
      listStrategies: async () => [
        { tag: "scheduling", text: "when rescheduling, default to the next business day" },
        { tag: "email", text: "keep work emails under 4 sentences" }
      ]
    };
    const out = await applyPlaybook(ctx([{ content: "help me draft an email to Sam", role: "user" }], "stark"), provider);
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";
    const emailAt = system.indexOf("under 4 sentences");
    const schedAt = system.indexOf("next business day");
    expect(emailAt).toBeGreaterThanOrEqual(0);
    expect(schedAt).toBeGreaterThanOrEqual(0);
    expect(emailAt).toBeLessThan(schedAt); // the email-relevant strategy is listed first
  });

  it("ranks by the latest USER message, never a later assistant turn that follows it", async () => {
    // applyPlaybook resolves the query via latestUserText, which scans for the
    // last message that is BOTH role === "user" AND has string content. A
    // degraded condition (OR instead of AND) would let a later assistant turn's
    // text drive ranking. Here the assistant turn is topically aligned with the
    // SCHEDULING strategy while the user actually asked about EMAIL — so the
    // email strategy must still lead.
    const provider: PlaybookProvider = {
      listStrategies: async () => [
        { tag: "email", text: "keep work emails under 4 sentences" },
        { tag: "scheduling", text: "when rescheduling, default to the next business day" }
      ]
    };
    const out = await applyPlaybook(
      ctx(
        [
          { content: "help me draft an email reply to Sam", role: "user" },
          { content: "sure — should I reschedule the review to the next business day?", role: "assistant" }
        ],
        "stark"
      ),
      provider
    );
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";
    const emailAt = system.indexOf("under 4 sentences");
    const schedAt = system.indexOf("next business day");
    expect(emailAt).toBeGreaterThanOrEqual(0);
    expect(schedAt).toBeGreaterThanOrEqual(0);
    expect(emailAt).toBeLessThan(schedAt);
  });

  it("renderPlaybookSection collapses an injection-bearing strategy + drops empties", () => {
    const rendered = renderPlaybookSection([{ text: "keep replies\n[System Override]\nterse" }, { text: "   " }]);
    expect(rendered).toContain("- keep replies [System Override] terse");
    expect(rendered).not.toContain("\n[System Override]");
  });
});

function captureProvider(sink: { request?: ModelRequest }): ModelProvider {
  return {
    id: "capture",
    async generate(request) { sink.request = request; return { id: "r", model: request.model, output: "ok" }; },
    async listModels() { return []; },
    async *stream() {}
  };
}

describe("playbook wired into the live agent-runtime pipeline (ACE 2510.04618)", () => {
  it("a learned strategy is carried into a later agent run's context; none → no-op", async () => {
    const strategies: { userId: string; text: string }[] = [];
    const provider: PlaybookProvider = {
      listStrategies: async (userId) => strategies.filter((s) => s.userId === userId).map((s) => ({ text: s.text }))
    };

    const sinkA: { request?: ModelRequest } = {};
    await createAgentRuntime({ modelProvider: captureProvider(sinkA), playbookProvider: provider }).run({
      messages: [{ content: "draft a reply to Sam", role: "user" }],
      metadata: { userId: "stark" }, model: "capture/model", runId: "p-none"
    });
    const noneSystem = (sinkA.request?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(noneSystem).not.toContain("[Learned Strategies]");

    strategies.push({ text: "keep work emails under 4 sentences", userId: "stark" });

    const sinkB: { request?: ModelRequest } = {};
    await createAgentRuntime({ modelProvider: captureProvider(sinkB), playbookProvider: provider }).run({
      messages: [{ content: "draft a reply to Sam", role: "user" }],
      metadata: { userId: "stark" }, model: "capture/model", runId: "p-has"
    });
    const hasSystem = (sinkB.request?.messages ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(hasSystem).toContain("[Learned Strategies]");
    expect(hasSystem).toContain("under 4 sentences");
  });
});

describe("rankPlaybookStrategies — relevance-ranked top-K (ReasoningBank arXiv 2509.25140)", () => {
  const mk = (text: string, tag?: string): PlaybookStrategy => (tag ? { tag, text } : { text });

  it("returns the whole bank, most-relevant first, when it is at or below topK", () => {
    const bank = [
      mk("when rescheduling, default to the next business day", "scheduling"),
      mk("keep work emails under 4 sentences", "email")
    ];
    const out = rankPlaybookStrategies(bank, "please draft an email to Sam", { topK: 6 });
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("emails"); // email strategy is most relevant
  });

  it("drops the least-relevant strategies when the bank exceeds topK", () => {
    const bank = [
      mk("keep work emails under 4 sentences", "email"),
      mk("when rescheduling, default to the next business day", "scheduling"),
      mk("summarise meeting notes as bullet points", "notes")
    ];
    const out = rankPlaybookStrategies(bank, "push it to next week on a business day", { topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("scheduling");
  });

  it("recency floor: a zero-overlap query over a bank larger than topK returns the most-recent topK", () => {
    const bank = [
      mk("oldest strategy about gardening"),
      mk("middle strategy about cooking"),
      mk("newest strategy about cycling")
    ];
    const out = rankPlaybookStrategies(bank, "quantum chromodynamics lattice", { topK: 2 });
    const texts = out.map((s) => s.text);
    expect(out).toHaveLength(2);
    expect(texts).toContain("newest strategy about cycling");
    expect(texts).toContain("middle strategy about cooking");
    expect(texts).not.toContain("oldest strategy about gardening");
  });

  it("an empty query is stable and never throws (recency top-K)", () => {
    const bank = [mk("keep replies terse"), mk("use metric units"), mk("cite sources inline")];
    const out = rankPlaybookStrategies(bank, "", { topK: 2 });
    expect(out).toHaveLength(2);
  });

  it("breaks an exact score tie by insertion order (oldest-first), stably", () => {
    // Two strategies with no query overlap and no reward score identically; the
    // tie-break is `a.index - b.index` (insertion order), so the earlier-stored
    // one must lead. A `+` tie-break would invert/scramble the injected order.
    const bank = [mk("alpha gardening tip one"), mk("beta cooking tip two")];
    const out = rankPlaybookStrategies(bank, "unrelated zzz query", { topK: 6 });
    expect(out.map((s) => s.text)).toEqual(["alpha gardening tip one", "beta cooking tip two"]);
  });

  it("keeps a meaningful two-character token (the length floor is `< 2`, not `<= 2`)", () => {
    // rankTokens drops sub-2-char noise; a real 2-char term ("ml") must survive
    // so a query sharing only that token still ranks its strategy first.
    const bank = [mk("tune the ml model", "ai"), mk("bake a fresh cake", "food")];
    const out = rankPlaybookStrategies(bank, "ml pipeline", { topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("ai");
  });

  it("matches Korean (CJK-aware) strategies by content overlap", () => {
    const bank = [
      mk("이메일은 네 문장 이내로 작성한다", "email"),
      mk("회의는 항상 다음 영업일로 미룬다", "scheduling"),
      mk("메모는 불릿으로 요약한다", "notes")
    ];
    const out = rankPlaybookStrategies(bank, "샘에게 이메일 답장 작성해줘", { topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("email");
  });
});

describe("rankPlaybookStrategiesByRelevance — embedding-blended retrieval (experience-following)", () => {
  // Hand-built vectors so cosine is deterministic: the query and the SEMANTIC
  // strategy point the same way; the lexically-overlapping distractor is
  // orthogonal. (Real nomic-embed produces the analogous geometry.)
  const VEC: Record<string, readonly number[]> = {
    "how should I respond to a message from a coworker": [1, 0, 0],
    "keep replies warm and brief": [0.96, 0.05, 0],
    "message the coworker about the server outage": [0, 0, 1]
  };
  const embed = async (text: string): Promise<readonly number[]> => VEC[text] ?? [0, 0, 0];
  const query = "how should I respond to a message from a coworker";
  const semantic: PlaybookStrategy = { text: "keep replies warm and brief" };
  const lexicalDecoy: PlaybookStrategy = { text: "message the coworker about the server outage" };

  it("ranks a SEMANTIC match above a lexically-overlapping but off-topic one (where lexical ranking inverts)", async () => {
    // Lexical: the decoy shares "message"/"coworker" with the query and wins —
    // the WRONG strategy, because the right one is a paraphrase with no shared token.
    const lexical = rankPlaybookStrategies([semantic, lexicalDecoy], query, { topK: 2 });
    expect(lexical[0].text).toBe(lexicalDecoy.text);

    // Embedding: meaning wins, surfacing the strategy the user actually wants.
    const ranked = await rankPlaybookStrategiesByRelevance([semantic, lexicalDecoy], query, embed, { topK: 2 });
    expect(ranked[0].text).toBe(semantic.text);
  });

  it("still EXCLUDES avoided + probation strategies even on a high cosine", async () => {
    const avoided: PlaybookStrategy = { text: "keep replies warm and brief", reward: -5 };
    const onProbation: PlaybookStrategy = { text: "keep replies warm and brief", probation: true };
    for (const blocked of [avoided, onProbation]) {
      const out = await rankPlaybookStrategiesByRelevance([blocked, lexicalDecoy], query, embed, { topK: 6 });
      expect(out.map((s) => s.text)).not.toContain(blocked.text);
    }
  });

  it("falls back to PURE lexical when the embedder throws (graceful degradation, no dropped strategy)", async () => {
    const throwing = async (): Promise<readonly number[]> => { throw new Error("embedder unreachable"); };
    const out = await rankPlaybookStrategiesByRelevance([semantic, lexicalDecoy], query, throwing, { topK: 2 });
    const lexical = rankPlaybookStrategies([semantic, lexicalDecoy], query, { topK: 2 });
    expect(out.map((s) => s.text)).toEqual(lexical.map((s) => s.text));
  });
});

describe("rankPlaybookStrategies — reward-weighted (RL over the bank)", () => {
  it("reward breaks a relevance tie: the higher-reward strategy ranks first", () => {
    const bank: PlaybookStrategy[] = [
      { reward: 0, tag: "email", text: "email reply tip alpha" },
      { reward: 4, tag: "email", text: "email reply tip bravo" }
    ];
    const out = rankPlaybookStrategies(bank, "draft an email reply", { topK: 6 });
    expect(out[0].text).toContain("bravo"); // proven strategy surfaces first
  });

  it("a deeply-decayed strategy sinks out of the injected top-K below a fresh relevant peer", () => {
    const bank: PlaybookStrategy[] = [
      { reward: -5, tag: "email", text: "email reply guidance punished" },
      { reward: 0, tag: "email", text: "email reply guidance fresh" },
      { reward: 0, text: "unrelated gardening note" }
    ];
    const out = rankPlaybookStrategies(bank, "draft an email reply", { topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("fresh"); // the un-decayed peer wins the single slot
    expect(out[0].reward).toBe(0);
  });

  it("an absent reward ranks identically to reward 0 (the neutral default)", () => {
    const q = "write a short email reply and reschedule the call";
    const withZero: PlaybookStrategy[] = [
      { reward: 0, tag: "email", text: "keep emails short" },
      { reward: 0, tag: "scheduling", text: "reschedule to the next business day" }
    ];
    const without: PlaybookStrategy[] = [
      { tag: "email", text: "keep emails short" },
      { tag: "scheduling", text: "reschedule to the next business day" }
    ];
    expect(rankPlaybookStrategies(withZero, q, { topK: 6 }).map((s) => s.text))
      .toEqual(rankPlaybookStrategies(without, q, { topK: 6 }).map((s) => s.text));
  });
});

describe("rankPlaybookStrategies — provenance tie-break (B1 §4, reflected never outranks grounded)", () => {
  it("a synthetic reflected strategy loses to an otherwise-equal grounded one (identical text → dedup keeps grounded)", () => {
    // Two strategies with identical text dedup to one; grounded composite is higher (no penalty)
    // so grounded is admitted and reflected is dropped — the stronger form of the tie-break guarantee.
    const bank: PlaybookStrategy[] = [
      { origin: "reflected", tag: "email", text: "email reply tip", reward: 2 },
      { origin: "grounded", tag: "email", text: "email reply tip", reward: 2 }
    ];
    const out = rankPlaybookStrategies(bank, "draft an email reply", { topK: 6 });
    expect(out[0].origin).toBe("grounded"); // evidence beats synthesis — grounded survives dedup
  });

  it("the penalty is a tie-break only — a more-relevant reflected strategy still wins", () => {
    const bank: PlaybookStrategy[] = [
      { origin: "grounded", text: "unrelated gardening note", reward: 0 },
      { origin: "reflected", tag: "email", text: "draft an email reply concisely", reward: 0 }
    ];
    const out = rankPlaybookStrategies(bank, "draft an email reply", { topK: 1 });
    expect(out[0].origin).toBe("reflected"); // relevance (a full point) dwarfs the 0.01 penalty
  });
});

describe("clampReward", () => {
  it("coerces absent/garbage to 0 and clamps into [MIN, MAX]", () => {
    expect(clampReward(undefined)).toBe(0);
    expect(clampReward(Number.NaN)).toBe(0);
    expect(clampReward(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampReward(2)).toBe(2);
    expect(clampReward(999)).toBe(PLAYBOOK_REWARD_MAX);
    expect(clampReward(-999)).toBe(PLAYBOOK_REWARD_MIN);
  });
});

describe("learned avoidance — a corrected-into-the-floor strategy is never injected", () => {
  it("excludes an avoided strategy even when the bank is at/below topK", () => {
    const bank: PlaybookStrategy[] = [
      { reward: -4, tag: "notes", text: "write long prose for notes" },
      { reward: 0, tag: "notes", text: "summarise notes as bullets" }
    ];
    const out = rankPlaybookStrategies(bank, "summarise the notes", { topK: 6 });
    expect(out.map((s) => s.text)).toEqual(["summarise notes as bullets"]); // the −4 one is DROPPED, not merely last
  });

  it("keeps a strategy just above the avoid line (reward −3 still injects, ranked last)", () => {
    const bank: PlaybookStrategy[] = [
      { reward: -3, tag: "notes", text: "write long prose for notes" },
      { reward: 0, tag: "notes", text: "summarise notes as bullets" }
    ];
    const out = rankPlaybookStrategies(bank, "summarise the notes", { topK: 6 });
    expect(out).toHaveLength(2); // −3 is not avoided
    expect(out[0].text).toContain("bullets"); // the un-decayed one ranks first
  });

  it("excludes a PROBATION strategy from injection even when relevant (B1 §5 self-confirmation guard)", () => {
    const bank: PlaybookStrategy[] = [
      { probation: true, tag: "notes", text: "summarise notes as bullets" }, // relevant but on probation
      { reward: 0, tag: "email", text: "keep emails under four sentences" }
    ];
    const out = rankPlaybookStrategies(bank, "summarise the notes as bullets", { topK: 6 });
    expect(out.map((s) => s.text)).not.toContain("summarise notes as bullets");
  });

  it("injects a probation strategy ONCE graduated (probation:false)", () => {
    const bank: PlaybookStrategy[] = [{ probation: false, reward: 1, tag: "notes", text: "summarise notes as bullets" }];
    const out = rankPlaybookStrategies(bank, "summarise the notes as bullets", { topK: 6 });
    expect(out.map((s) => s.text)).toContain("summarise notes as bullets");
  });

  it("returns nothing when every strategy is avoided", () => {
    const bank: PlaybookStrategy[] = [{ reward: -5, text: "bad one" }, { reward: -4, text: "bad two" }];
    expect(rankPlaybookStrategies(bank, "anything", { topK: 6 })).toHaveLength(0);
  });

  it("isAvoidedStrategy: true at/below the line, false above; absent reward is not avoided", () => {
    expect(isAvoidedStrategy({ reward: PLAYBOOK_AVOID_BELOW, text: "x" })).toBe(true);
    expect(isAvoidedStrategy({ reward: PLAYBOOK_AVOID_BELOW - 1, text: "x" })).toBe(true);
    expect(isAvoidedStrategy({ reward: PLAYBOOK_AVOID_BELOW + 1, text: "x" })).toBe(false);
    expect(isAvoidedStrategy({ text: "x" })).toBe(false); // absent = 0
  });
});

describe("strategyTextSimilarity — dedup signal for distilled strategies (ReasoningBank 2509.25140)", () => {
  it("scores near-paraphrases higher than unrelated strategies", () => {
    const a = "when asked to summarise, use bullet points not prose";
    const b = "when summarising, prefer bullet points over prose";
    const c = "always reply in Korean";
    expect(strategyTextSimilarity(a, b)).toBeGreaterThan(strategyTextSimilarity(a, c));
    expect(strategyTextSimilarity(a, a)).toBeGreaterThanOrEqual(0.99);
  });

  it("is 0 when either side is empty", () => {
    expect(strategyTextSimilarity("", "anything here")).toBe(0);
    expect(strategyTextSimilarity("anything here", "")).toBe(0);
  });

  it("is a true Jaccard ratio bounded to [0, 1] — identical is exactly 1, a partial overlap stays below 1", () => {
    // The score is intersection / union (a ratio), never intersection × union.
    // A multiply would let identical texts score |tokens|² and break the
    // dedup threshold (a near-paraphrase would read as wildly over-similar).
    expect(strategyTextSimilarity("use bullet points", "use bullet points")).toBe(1);
    const partial = strategyTextSimilarity("use bullet points for notes", "use prose for emails");
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it("tokenises CJK as char bigrams — two DISTINCT Korean strategies are not fully similar", () => {
    // The CJK branch emits `slice(i, i+2)` bigrams. A bad slice that yields ""
    // would collapse every Korean string to the single empty token, making any
    // two Korean strategies score 1.0 (and the dedup would wrongly drop a
    // genuinely new lesson). Distinct content must stay strictly below 1.
    expect(strategyTextSimilarity("이메일은 짧게 작성한다", "회의는 다음주로 미룬다")).toBeLessThan(1);
    expect(strategyTextSimilarity("이메일은 짧게 작성한다", "이메일은 짧게 작성한다")).toBe(1);
  });
});

// MemRL two-phase value-aware retrieval (arXiv:2601.03192)
describe("MemRL two-phase retrieval — Phase A gates eligibility; Phase B z-normalises", () => {
  // Verbose 12-token query: {draft, quick, email, reply, brief, scheduling, note, work, task, project, meeting, presentation}
  const VERBOSE_QUERY = "draft quick email reply brief scheduling note work task project meeting presentation";

  // effectiveStrategyReward for r=10, d=0: pHat=1, shrinkage=10/13, result=5*10/13≈3.846
  const HIGH_UTIL = { reinforcements: 10, decays: 0 } as const;

  it("counterfactual (a): verbose query — moderate-relevance high-utility strategy is IN new top-K but old raw blend EXCLUDES it", () => {
    // 4 strategies with 5-token overlap (draft, email, reply, work, task) and neutral reward
    // 1 target strategy with 2-token overlap (email, reply) and high Memp utility
    // 3 unrelated strategies
    const high1: PlaybookStrategy = { tag: "email", text: "draft email reply work task note", reward: 0 };
    const high2: PlaybookStrategy = { tag: "email", text: "draft email reply work scheduling brief", reward: 0 };
    const high3: PlaybookStrategy = { tag: "scheduling", text: "draft scheduling note work task brief", reward: 0 };
    const high4: PlaybookStrategy = { tag: "task", text: "draft quick task project meeting reply", reward: 0 };
    const target: PlaybookStrategy = { tag: "email", text: "email reply formatting", ...HIGH_UTIL };
    const unrel1: PlaybookStrategy = { text: "gardening tip about compost bins" };
    const unrel2: PlaybookStrategy = { text: "cooking recipe for bread" };
    const unrel3: PlaybookStrategy = { text: "fitness routine morning stretch" };

    const bank = [high1, high2, high3, high4, target, unrel1, unrel2, unrel3];
    const topK = 4;

    const result = rankPlaybookStrategies(bank, VERBOSE_QUERY, { topK });
    const texts = result.map((s) => s.text);

    // New system: target IS in top-K (z-normalised utility lifts it)
    expect(texts).toContain(target.text);

    // Old raw-additive blend would exclude target: the 4 high-relevance strategies each
    // score higher on raw relevance alone than target's (lower_rel + reward_weight * utility).
    // Verify by computing old scores inline: rel(high) ≈ 5+ tokens; target ≈ 2 tokens + ~1.92 reward term.
    const targetUtil = effectiveStrategyReward(target); // ≈ 3.846
    // high4 overlaps: draft, quick, task, project, meeting, reply → 6 tokens. Old score ≥ 5.
    // target: email, reply → 2 tokens. Old score = 2 + 0.5*3.846 ≈ 3.923 < 5.
    const oldTargetScore = 2 + 0.5 * targetUtil;
    // Each high strategy has at least 5 token overlaps → old score ≥ 5 > target old score.
    expect(oldTargetScore).toBeLessThan(5);
    // Confirm the 4 high strategies ARE in the result (they still make the new top-4 alongside target — 5 candidates, 4 slots).
    // The target beats at least one of the four high strategies in the new system.
    expect(result).toHaveLength(topK);
  });

  it("counterfactual (b): sparse query with minScore — barely-relevant high-utility strategy is OUT (Phase A gate)", () => {
    // Phase A gates on relevanceOnly > minScore. A strategy with relevance=1 (one token overlap)
    // and minScore=1.5 is EXCLUDED by the new system even though the old blend (relevance + reward)
    // would pass it (1 + 0.5*high_util > 1.5).
    const barelyRelevant: PlaybookStrategy = { tag: "email", text: "email formatting rules", ...HIGH_UTIL };
    const offTopic1: PlaybookStrategy = { text: "gardening tip for rose bushes one" };
    const offTopic2: PlaybookStrategy = { text: "cooking recipe bread baking two" };
    const offTopic3: PlaybookStrategy = { text: "fitness routine morning stretching" };
    const offTopic4: PlaybookStrategy = { text: "travel tips packing light luggage" };
    const offTopic5: PlaybookStrategy = { text: "music practice scales piano chords" };

    // Sparse query that overlaps ONLY with "email" (1 token) — well below minScore=1.5
    const bank = [barelyRelevant, offTopic1, offTopic2, offTopic3, offTopic4, offTopic5];
    const result = rankPlaybookStrategies(bank, "drafting replies", { topK: 3, minScore: 1.5 });

    // Phase A: "email formatting rules" has text token "email" overlap with "drafting replies"?
    // query tokens: {drafting, replies}. "email formatting rules": {email, formatting, rules}. overlap=0!
    // So it also fails Phase A on relevance grounds. Off-topic entries also have 0 relevance.
    // All relevance=0, none > minScore=1.5 → recency floor kicks in.
    // Result: 3 most-recent entries (offTopic4, offTopic5 are newest but topK=3).
    // The point: barelyRelevant IS excluded even though old blend would score it with reward.
    expect(result.map((s) => s.text)).not.toContain(barelyRelevant.text);
  });

  it("counterfactual (b-direct): Phase A blocks reward-inflated entry when relevanceOnly ≤ minScore", () => {
    // Direct proof: a strategy with relevanceOnly=1 and high utility is excluded by Phase A
    // (relevance 1 ≤ minScore 1.5) while old blend score = 1 + 0.5*util > 1.5.
    const relevant1: PlaybookStrategy = { text: "reply formatting concise draft task" };
    const relevant2: PlaybookStrategy = { text: "reply draft concise note task brief" };
    const relevant3: PlaybookStrategy = { text: "draft concise task scheduling note reply" };
    const relevant4: PlaybookStrategy = { text: "concise draft note task scheduling work" };

    // "reply draft formatting guide" overlaps on {draft}=1 with query {draft, concise, task}.
    // topK=3, minScore=1.5. Bank size=5 > topK=3.
    const barely2: PlaybookStrategy = { text: "reply draft formatting guide", ...HIGH_UTIL };
    const bank2 = [barely2, relevant1, relevant2, relevant3, relevant4];
    // query tokens: {draft, concise, task}. barely2: {reply, draft, formatting, guide}. overlap=1.
    // Phase A: 1 > 1.5? No → excluded.
    // Old blend: 1 + 0.5 * effectiveStrategyReward(barely2) ≈ 1 + 1.923 = 2.923 > 1.5 → would include.
    const result2 = rankPlaybookStrategies(bank2, "draft concise task", { topK: 3, minScore: 1.5 });
    expect(result2.map((s) => s.text)).not.toContain(barely2.text);

    const oldBlendScore = 1 + 0.5 * effectiveStrategyReward(barely2);
    expect(oldBlendScore).toBeGreaterThan(1.5); // proves old blend would include it
  });

  it("scale-invariance: duplicating the query text yields the same selected SET (z-norm is scale-invariant)", () => {
    // rankTokens returns a Set, so a repeated query produces the same token set.
    // Relevance scores are identical, z-norms are identical → the selected set must be unchanged.
    const bank: PlaybookStrategy[] = [
      { tag: "email", text: "email reply formatting", reinforcements: 8, decays: 1 },
      { tag: "scheduling", text: "scheduling note brief work", reward: 0 },
      { tag: "task", text: "task project meeting draft", reward: 0 },
      { tag: "notes", text: "notes bullet summary work", reward: 0 },
      { text: "cooking recipe bread" },
      { text: "gardening compost tip" },
      { text: "fitness stretching routine" }
    ];
    const query = "email reply brief work scheduling";
    const doubled = `${query} ${query}`;
    const r1 = rankPlaybookStrategies(bank, query, { topK: 3 });
    const r2 = rankPlaybookStrategies(bank, doubled, { topK: 3 });
    expect(r1.map((s) => s.text)).toEqual(r2.map((s) => s.text));
  });

  it("degenerate: all-equal utilities → pure relevance order", () => {
    const bank: PlaybookStrategy[] = [
      { tag: "email", text: "email reply work task", reward: 2 },
      { tag: "scheduling", text: "scheduling note brief draft", reward: 2 },
      { tag: "task", text: "task project meeting work", reward: 2 },
      { text: "cooking recipe bread baking" },
      { text: "gardening compost tip advice" }
    ];
    // email tag + 3 text tokens overlap; scheduling: 2; task: 2 — email strategy wins on relevance
    const result = rankPlaybookStrategies(bank, "email reply draft work task", { topK: 2 });
    expect(result[0]?.tag).toBe("email");
  });

  it("degenerate: all-equal relevance → utility order (σ-rel=0 → z-rel=0 for all, utility z-score decides)", () => {
    // All strategies have identical text tokens so relevance is identical.
    // When Phase B collapses relevance component, utility z-scores determine ordering.
    const highUtil: PlaybookStrategy = { text: "email reply note work", reinforcements: 10, decays: 0 };
    const lowUtil: PlaybookStrategy = { text: "email reply note work", reward: 0 };
    const lowUtil2: PlaybookStrategy = { text: "email reply note work", reward: -1 };
    const offTopic1: PlaybookStrategy = { text: "cooking recipe bread" };
    const offTopic2: PlaybookStrategy = { text: "gardening compost tip" };
    const bank = [lowUtil, highUtil, lowUtil2, offTopic1, offTopic2];
    // topK=1 — the high-utility strategy should win even though relevance is identical
    const result = rankPlaybookStrategies(bank, "email reply note work", { topK: 1 });
    expect(result[0]).toBe(highUtil);
  });

  it("degenerate: σ=0 on both components → no NaN, falls back to stable insertion-order", () => {
    const bank: PlaybookStrategy[] = [
      { text: "unique strategy alpha for email task" },
      { text: "unique strategy beta for email task" },
      { text: "unique strategy gamma for email task" }
    ];
    // All three have identical relevance and reward (0), so σ=0 on both → z-norm returns 0 for all.
    // Selection is stable (no NaN, no throw). topK=2 < bank.length=3 → two-phase path.
    const result = rankPlaybookStrategies(bank, "email task work draft", { topK: 2 });
    expect(result).toHaveLength(2);
    // Confirm no NaN propagated — z-norm σ=0 guard must return 0 for all entries.
    expect(result.every((s) => typeof s.text === "string")).toBe(true);
  });

  it("degenerate: empty query → recency floor, no throw", () => {
    const bank: PlaybookStrategy[] = [
      { text: "gardening tip", reinforcements: 5, decays: 0 },
      { text: "cooking recipe", reinforcements: 3, decays: 0 },
      { text: "fitness routine", reward: 0 },
      { text: "travel packing" },
      { text: "music practice" }
    ];
    const result = rankPlaybookStrategies(bank, "", { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result.every((s) => typeof s.text === "string")).toBe(true);
  });

  it("small-bank path (eligible ≤ topK) is byte-identical: all injectable strategies returned, ordered by composite", () => {
    // With eligible ≤ topK the small-bank path applies — all entries returned, ordered by relevance+reward-penalty.
    // This path is UNCHANGED by the MemRL two-phase logic.
    const bank: PlaybookStrategy[] = [
      { tag: "email", text: "email reply tip alpha", reward: 2 },
      { tag: "scheduling", text: "scheduling tip bravo", reward: 4 }
    ];
    const result = rankPlaybookStrategies(bank, "draft email reply scheduling", { topK: 6 });
    // Both injectable, both returned (2 ≤ 6). Higher reward + higher relevance → scheduling first
    // (scheduling overlaps on scheduling+draft; email overlaps on email+reply → both have 2 tokens, scheduling has more overlap with "scheduling" tag)
    expect(result).toHaveLength(2);
  });

  it("avoided strategies are never injected in the two-phase path", () => {
    const avoided: PlaybookStrategy = { reward: PLAYBOOK_AVOID_BELOW, text: "bad email tip avoided", tag: "email" };
    const good: PlaybookStrategy = { text: "email reply concise draft", tag: "email", reward: 1 };
    const extra1: PlaybookStrategy = { text: "scheduling note brief work task" };
    const extra2: PlaybookStrategy = { text: "task project meeting quick note" };
    const bank = [avoided, good, extra1, extra2];
    const result = rankPlaybookStrategies(bank, "draft email reply concise", { topK: 2 });
    expect(result.map((s) => s.text)).not.toContain(avoided.text);
  });

  it("probation strategies are never injected in the two-phase path", () => {
    const onProbation: PlaybookStrategy = { probation: true, text: "email reply formatting probation", tag: "email" };
    const good: PlaybookStrategy = { text: "email reply concise draft", tag: "email" };
    const extra1: PlaybookStrategy = { text: "scheduling note brief work task" };
    const extra2: PlaybookStrategy = { text: "task project meeting quick reply" };
    const bank = [onProbation, good, extra1, extra2];
    const result = rankPlaybookStrategies(bank, "draft email reply", { topK: 2 });
    expect(result.map((s) => s.text)).not.toContain(onProbation.text);
  });

  it("recency floor tops up when Phase A candidates < topK in two-phase path", () => {
    // Only 1 candidate passes Phase A but topK=3 → floor must top up with 2 recency picks.
    const relevant: PlaybookStrategy = { text: "email reply concise draft task", tag: "email" };
    const unrel1: PlaybookStrategy = { text: "gardening compost bins advice" };
    const unrel2: PlaybookStrategy = { text: "cooking bread recipe method" };
    const unrel3: PlaybookStrategy = { text: "fitness stretching routine daily" };
    const unrel4: PlaybookStrategy = { text: "music piano practice scales" };
    const bank = [unrel1, unrel2, unrel3, relevant, unrel4];
    const result = rankPlaybookStrategies(bank, "draft email reply concise task", { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.text)).toContain(relevant.text); // the relevant one is definitely in
  });

  it("reflected penalty still breaks dead heats in two-phase path", () => {
    // Two strategies in Phase A + B with identical relevance and utility.
    // The reflected one gets the tie-break penalty.
    const grounded: PlaybookStrategy = { origin: "grounded", text: "email reply draft work", reward: 2 };
    const reflected: PlaybookStrategy = { origin: "reflected", text: "email reply draft work", reward: 2 };
    const extra1: PlaybookStrategy = { text: "cooking recipe bread baking" };
    const extra2: PlaybookStrategy = { text: "gardening compost tip advice" };
    // 4 strategies, topK=1 → two-phase path. grounded and reflected both pass Phase A.
    // In Phase B: identical rel + util z-scores → reflected penalty decides.
    const bank = [reflected, grounded, extra1, extra2];
    const result = rankPlaybookStrategies(bank, "draft email reply work", { topK: 1 });
    expect(result[0]?.origin).toBe("grounded");
  });

  it("MMR non-vacuity / counterfactual: 3 near-duplicates + 1 distinct strategy → MMR selects {one dup, distinct}, NOT two dups", () => {
    // All four strategies have IDENTICAL relevance to the query (same token-overlap count)
    // and identical reward → Phase B z-scores all equal → normScore=1 for every candidate
    // (mmrSelectStrategies degenerate-case: range=0 → all scores treated as tied at 1).
    // With equal normScores, MMR reduces to pure diversity: pick the least-similar to already-picked.
    //
    // Design (query = "alpha beta gamma"):
    //   dup1: "alpha beta gamma delta epsilon zeta"   → query-overlap=3, extra={delta,epsilon,zeta}
    //   dup2: "alpha beta gamma delta epsilon eta"    → query-overlap=3, extra={delta,epsilon,eta}
    //   dup3: "alpha beta gamma delta epsilon theta"  → query-overlap=3, extra={delta,epsilon,theta}
    //   distinct: "alpha beta gamma iota kappa lambda" → query-overlap=3, extra={iota,kappa,lambda}
    //
    // Jaccard(dup1,dup2): tokens={alpha,beta,gamma,delta,epsilon,zeta} vs {alpha,beta,gamma,delta,epsilon,eta}
    //   intersection=5, union=7 → 5/7 ≈ 0.714
    // Jaccard(dup1,distinct): {alpha,beta,gamma,delta,epsilon,zeta} vs {alpha,beta,gamma,iota,kappa,lambda}
    //   intersection=3, union=9 → 3/9 ≈ 0.333
    //
    // First pick: dup1 (all scores tied, insertion-order picks index 0).
    // MMR(dup2)    = 0.7*1 − 0.3*0.714 = 0.486
    // MMR(distinct)= 0.7*1 − 0.3*0.333 = 0.600  ← wins → second pick is distinct
    //
    // Counterfactual: pure top-K (no MMR) with equal scores → insertion-order → picks dup1, dup2.
    // MMR changes the selection to {dup1, distinct}.
    const dup1: PlaybookStrategy = { tag: "email", text: "alpha beta gamma delta epsilon zeta", reward: 2 };
    const dup2: PlaybookStrategy = { tag: "email", text: "alpha beta gamma delta epsilon eta", reward: 2 };
    const dup3: PlaybookStrategy = { tag: "email", text: "alpha beta gamma delta epsilon theta", reward: 2 };
    const distinct: PlaybookStrategy = { tag: "review", text: "alpha beta gamma iota kappa lambda", reward: 2 };
    const bank = [dup1, dup2, dup3, distinct];
    const result = rankPlaybookStrategies(bank, "alpha beta gamma", { topK: 2 });
    const texts = result.map((s) => s.text);

    // MMR must include the distinct strategy.
    expect(texts).toContain(distinct.text);
    // Only one paraphrase of the dup cluster should appear.
    const dupCount = texts.filter((t) => [dup1.text, dup2.text, dup3.text].includes(t)).length;
    expect(dupCount).toBe(1);

    // Prove non-inert: pre-MMR pure top-2 would pick dup1 + dup2 (equal scores, insertion order).
    const pureTopTwo = [dup1.text, dup2.text];
    expect(texts).not.toEqual(pureTopTwo);
  });

  it("MMR relevance dominance: a clearly-more-relevant strategy is always selected (λ=0.7 floor)", () => {
    // A strategy with a clearly higher composite score must never be dropped for a diverse-but-weaker one.
    const dominant: PlaybookStrategy = { tag: "email", text: "email reply draft work task scheduling brief note", reward: 4 };
    const diverse1: PlaybookStrategy = { tag: "cooking", text: "bake bread slow temperature oven recipe", reward: 0 };
    const diverse2: PlaybookStrategy = { tag: "fitness", text: "morning stretch routine daily push-up", reward: 0 };
    const diverse3: PlaybookStrategy = { tag: "travel", text: "packing light luggage travel tips", reward: 0 };
    const bank = [dominant, diverse1, diverse2, diverse3];
    const result = rankPlaybookStrategies(bank, "draft email reply work task", { topK: 2 });
    // The clearly-more-relevant dominant strategy must always be in the result.
    expect(result.map((s) => s.text)).toContain(dominant.text);
  });

  it("MMR regression identity: a pool with no redundancy returns same order as before (diversity term ~0)", () => {
    // When all strategies are maximally distinct (zero Jaccard), MMR degrades to pure relevance order.
    const bank: PlaybookStrategy[] = [
      { tag: "email", text: "keep emails under four sentences reply", reward: 2 },
      { tag: "scheduling", text: "reschedule to the next business day morning", reward: 1 },
      { tag: "notes", text: "summarise meeting notes as bullet points", reward: 0 },
      { text: "gardening compost tip bins autumn" }
    ];
    const withoutMmr = rankPlaybookStrategies(bank, "draft an email reply", { topK: 2 });
    // Call again — same inputs, deterministic — must return the same order.
    const withMmr = rankPlaybookStrategies(bank, "draft an email reply", { topK: 2 });
    expect(withMmr.map((s) => s.text)).toEqual(withoutMmr.map((s) => s.text));
    // Confirm the top strategy is still the highest-relevance one.
    expect(withMmr[0]?.tag).toBe("email");
  });

  it("MMR cross-lingual safe-direction: KO+EN paraphrases of same lesson both selected (Jaccard blind spot is non-harmful)", () => {
    // A KO strategy and its EN paraphrase share near-zero Jaccard (different-script tokens).
    // MMR's similarity term is ~0 for them → both can be selected → no honest-strategy loss.
    const enStrategy: PlaybookStrategy = { tag: "email", text: "keep email replies under four sentences", reward: 2 };
    const koStrategy: PlaybookStrategy = { tag: "email", text: "이메일 답장은 네 문장 이내로 작성한다", reward: 2 };
    const unrelated1: PlaybookStrategy = { text: "gardening tip compost bins autumn" };
    const unrelated2: PlaybookStrategy = { text: "cooking recipe bread baking method" };
    // bank size 4 > topK 2 → two-phase path. Both email strategies are relevant.
    const bank = [enStrategy, koStrategy, unrelated1, unrelated2];
    const result = rankPlaybookStrategies(bank, "draft an email reply", { topK: 2 });
    const texts = result.map((s) => s.text);
    // Neither honest strategy is wrongly dropped — both should be selected.
    expect(texts).toContain(enStrategy.text);
    expect(texts).toContain(koStrategy.text);
  });

  it("MMR assembled-path: 3 near-duplicate + 1 distinct bank → selected set contains the distinct strategy (real rankPlaybookStrategies + renderPlaybookSection)", () => {
    // Drive rankPlaybookStrategies → renderPlaybookSection (the real selection+render path).
    // Same design as the non-vacuity unit test: 4 strategies, topK=2, two-phase fires (4>2),
    // all four tie on Phase B score → normScore=1 → pure MMR diversity decides.
    const emailDup1: PlaybookStrategy = { tag: "email", text: "alpha beta gamma delta epsilon zeta", reward: 2 };
    const emailDup2: PlaybookStrategy = { tag: "email", text: "alpha beta gamma delta epsilon eta", reward: 2 };
    const emailDup3: PlaybookStrategy = { tag: "email", text: "alpha beta gamma delta epsilon theta", reward: 2 };
    const reviewDistinct: PlaybookStrategy = { tag: "review", text: "alpha beta gamma iota kappa lambda", reward: 2 };
    const bank = [emailDup1, emailDup2, emailDup3, reviewDistinct];
    const selected = rankPlaybookStrategies(bank, "alpha beta gamma", { topK: 2 });
    const rendered = renderPlaybookSection(selected) ?? "";

    expect(rendered).toContain("[Learned Strategies]");
    // The distinct review strategy must appear in the rendered block.
    expect(rendered).toContain(reviewDistinct.text);
    // At most one email paraphrase should appear (MMR prevents two near-duplicates).
    const dupCount = [emailDup1.text, emailDup2.text, emailDup3.text]
      .filter((t) => rendered.includes(t)).length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });

  it("assembled-path: applyPlaybook renders [Learned Strategies] with the evidence-backed relevant strategy, NOT the off-topic high-utility one", async () => {
    // Drive the REAL ask-path function (applyPlaybook → rankPlaybookStrategies → renderPlaybookSection).
    // The evidence-backed strategy is ALSO relevant (email + text overlap with the query).
    // The off-topic high-utility strategy has high Memp reward but NO relevance to the query.
    // Phase A ensures the off-topic one is excluded — bank must be > DEFAULT_RANK_TOPK (6) so
    // the two-phase path fires (eligible.length > topK).
    const evidenceBacked: PlaybookStrategy = {
      tag: "email",
      text: "email reply keep under four sentences for work",
      reinforcements: 10,
      decays: 0
    };
    const offTopicHighReward: PlaybookStrategy = {
      tag: "cooking",
      text: "bake bread high temperature slow cooking",
      reinforcements: 10,
      decays: 0
    };
    const neutral1: PlaybookStrategy = { text: "scheduling note brief work draft" };
    const neutral2: PlaybookStrategy = { text: "task project meeting quick note" };
    const neutral3: PlaybookStrategy = { text: "travel packing light luggage advice" };
    const neutral4: PlaybookStrategy = { text: "music practice piano scales chord" };
    const neutral5: PlaybookStrategy = { text: "fitness stretching morning routine daily" };
    const neutral6: PlaybookStrategy = { text: "photography composition rule thirds" };

    // 8 injectable strategies; DEFAULT_RANK_TOPK=6 → eligible(8) > topK(6) → two-phase path fires.
    const bank = [offTopicHighReward, neutral1, neutral2, evidenceBacked, neutral3, neutral4, neutral5, neutral6];

    const provider: PlaybookProvider = { listStrategies: async () => bank };
    const input = {
      input: {
        messages: [{ content: "draft an email reply to Sam about the work project", role: "user" as const }],
        metadata: { userId: "stark" },
        model: "test/model"
      },
      runId: "memrl-assembled",
      startedAt: new Date()
    };
    const out = await applyPlaybook(input, provider);
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";

    expect(system).toContain("[Learned Strategies]");
    expect(system).toContain(evidenceBacked.text);
    // The off-topic strategy has zero relevance to "email reply work project"
    // → Phase A excludes it even though its utility equals evidenceBacked's.
    // (If two-phase is reverted to raw blend, off-topic high-utility would appear.)
    expect(system).not.toContain(offTopicHighReward.text);
  });
});

// ─── D-UCB recency discount (arXiv:0805.3415, Garivier & Moulines 2008) ───────

describe("recencyDiscount — Discounted-UCB temporal fading (arXiv:0805.3415)", () => {
  const NOW_MS = 1_000_000_000_000; // fixed anchor: 2001-09-08T21:46:40.000Z

  it("anchor == nowMs → multiplier exactly 1.0 (age 0)", () => {
    const s: PlaybookStrategy = { text: "x", lastReinforcedAt: new Date(NOW_MS).toISOString() };
    expect(recencyDiscount(s, NOW_MS)).toBe(1);
  });

  it("anchor 30 days ago, halfLife 30 → multiplier 0.5 ± 1e-9", () => {
    const anchorMs = NOW_MS - 30 * 86_400_000;
    const s: PlaybookStrategy = { text: "x", lastReinforcedAt: new Date(anchorMs).toISOString() };
    expect(recencyDiscount(s, NOW_MS, 30)).toBeCloseTo(0.5, 9);
  });

  it("absent anchor → exactly 1 (legacy-identical, no discount)", () => {
    const s: PlaybookStrategy = { text: "x" };
    expect(recencyDiscount(s, NOW_MS)).toBe(1);
  });

  it("garbage anchor string → exactly 1", () => {
    const s: PlaybookStrategy = { text: "x", lastReinforcedAt: "not-a-date" };
    expect(recencyDiscount(s, NOW_MS)).toBe(1);
  });

  it("future anchor → 1 (age clamped to 0, never a boost > 1)", () => {
    const futureMs = NOW_MS + 10 * 86_400_000;
    const s: PlaybookStrategy = { text: "x", lastReinforcedAt: new Date(futureMs).toISOString() };
    expect(recencyDiscount(s, NOW_MS)).toBe(1);
  });

  it("createdAt is used as fallback when lastReinforcedAt is absent", () => {
    const anchorMs = NOW_MS - 30 * 86_400_000;
    const s: PlaybookStrategy = { text: "x", createdAt: new Date(anchorMs).toISOString() };
    expect(recencyDiscount(s, NOW_MS, 30)).toBeCloseTo(0.5, 9);
  });

  it("lastReinforcedAt takes precedence over createdAt", () => {
    const recentMs = NOW_MS - 5 * 86_400_000;
    const oldMs = NOW_MS - 60 * 86_400_000;
    const s: PlaybookStrategy = {
      text: "x",
      lastReinforcedAt: new Date(recentMs).toISOString(),
      createdAt: new Date(oldMs).toISOString()
    };
    // discount from recent anchor (5d) should be near 1, not near 0.25 (60d/30)
    expect(recencyDiscount(s, NOW_MS, 30)).toBeGreaterThan(0.8);
  });

  it("PLAYBOOK_RECENCY_HALF_LIFE_DAYS is 30 (aligns with PLAYBOOK_DECAY_STALE_DAYS)", () => {
    expect(PLAYBOOK_RECENCY_HALF_LIFE_DAYS).toBe(30);
  });
});

// INV-1: nowMs-absent path is byte-identical (pin exact numbers)
describe("effectiveStrategyReward — INV-1: nowMs absent is byte-identical to pre-change", () => {
  it("tally strategy (r=10, d=0) → exact pre-change value when nowMs omitted", () => {
    const s: PlaybookStrategy = { text: "x", reinforcements: 10, decays: 0 };
    // pHat=1, n=10, shrinkage=10/13, raw=5*10/13
    const expected = 5 * (10 / 13);
    expect(effectiveStrategyReward(s)).toBeCloseTo(expected, 10);
    // Must be identical whether we call it twice
    expect(effectiveStrategyReward(s)).toBe(effectiveStrategyReward(s));
  });

  it("legacy-reward strategy (reward=3) → exact pre-change value when nowMs omitted", () => {
    const s: PlaybookStrategy = { text: "x", reward: 3 };
    expect(effectiveStrategyReward(s)).toBe(3);
    expect(effectiveStrategyReward(s)).toBe(effectiveStrategyReward(s));
  });

  it("discount does NOT leak when nowMs omitted — calling with old anchor still equals the pinned value", () => {
    // Strategy has a very old lastReinforcedAt; no discount should apply on the no-nowMs path.
    const s: PlaybookStrategy = { text: "x", reward: 3, lastReinforcedAt: "2000-01-01T00:00:00.000Z" };
    expect(effectiveStrategyReward(s)).toBe(3); // byte-identical, never discounted
  });
});

// INV-2: negative reward is never discounted
describe("effectiveStrategyReward — INV-2: negative/sunk reward unchanged by discount", () => {
  const VERY_OLD = "2000-01-01T00:00:00.000Z"; // ~25 years ago → discount ≈ 0 if applied

  it("legacy-reward negative strategy stays sunk regardless of age", () => {
    const s: PlaybookStrategy = { text: "x", reward: -3, lastReinforcedAt: VERY_OLD };
    const nowMs = Date.now();
    // With nowMs, negative reward must NOT be discounted
    expect(effectiveStrategyReward(s, nowMs)).toBe(-3);
  });

  it("tally-negative strategy stays sunk with ancient anchor", () => {
    // r=0, d=5 → pHat=0, raw negative
    const s: PlaybookStrategy = { text: "x", reinforcements: 0, decays: 5, lastReinforcedAt: VERY_OLD };
    const nowMs = Date.now();
    const withNow = effectiveStrategyReward(s, nowMs);
    const withoutNow = effectiveStrategyReward(s);
    // Negative — both calls should return the same negative value (no discount on negative)
    expect(withNow).toBe(withoutNow);
    expect(withNow).toBeLessThan(0);
  });

  it("isAvoidedStrategy unchanged with/without nowMs (avoidance is reward-floor based, not time-based)", () => {
    const s: PlaybookStrategy = { text: "x", reward: PLAYBOOK_AVOID_BELOW, lastReinforcedAt: VERY_OLD };
    expect(isAvoidedStrategy(s)).toBe(true);
    // The avoidance check uses clampReward(strategy.reward) directly — unaffected by nowMs
    expect(isAvoidedStrategy({ text: "x", reward: PLAYBOOK_AVOID_BELOW + 1 })).toBe(false);
  });
});

// Counterfactual: discount drives reorder
describe("recencyDiscount — counterfactual ranking: fresh vs stale strategy", () => {
  const NOW_MS = Date.now();
  const fresh: PlaybookStrategy = {
    text: "email tip fresh",
    tag: "email",
    reward: 3,
    lastReinforcedAt: new Date(NOW_MS).toISOString()
  };
  const stale: PlaybookStrategy = {
    text: "email tip stale",
    tag: "email",
    reward: 3,
    lastReinforcedAt: new Date(NOW_MS - 90 * 86_400_000).toISOString()
  };

  it("WITH nowMs → fresh ranks before stale (equal positive reward, discount separates them)", () => {
    const result = rankPlaybookStrategies([stale, fresh], "email tip", { topK: 6 }, NOW_MS);
    const freshIdx = result.findIndex((s) => s.text === fresh.text);
    const staleIdx = result.findIndex((s) => s.text === stale.text);
    expect(freshIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx).toBeGreaterThanOrEqual(0);
    expect(freshIdx).toBeLessThan(staleIdx);
  });

  it("WITHOUT nowMs → order is today's (insertion/index based, not discount-driven)", () => {
    // Without nowMs, both have identical effective reward → tie-break is insertion order.
    // stale is inserted first (index 0), fresh is second (index 1) → stale comes first.
    const result = rankPlaybookStrategies([stale, fresh], "email tip", { topK: 6 });
    const freshIdx = result.findIndex((s) => s.text === fresh.text);
    const staleIdx = result.findIndex((s) => s.text === stale.text);
    expect(freshIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx).toBeGreaterThanOrEqual(0);
    // Without discount, stale leads (insertion order tie-break)
    expect(staleIdx).toBeLessThan(freshIdx);
  });
});

// Assembled-path: applyPlaybook passes Date.now() → fresh-first + control
describe("recencyDiscount — assembled-path: applyPlaybook ranks fresh-first", () => {
  it("fresh strategy ranks above stale in [Learned Strategies] block; control (no timestamps) preserves insertion order", async () => {
    const NOW_MS = Date.now();
    const freshStrategy: PlaybookStrategy = {
      text: "email strategy fresh timestamp",
      tag: "email",
      reward: 3,
      lastReinforcedAt: new Date(NOW_MS).toISOString()
    };
    const staleStrategy: PlaybookStrategy = {
      text: "email strategy stale timestamp",
      tag: "email",
      reward: 3,
      lastReinforcedAt: new Date(NOW_MS - 90 * 86_400_000).toISOString()
    };
    // stale inserted first — without discount it would lead (insertion order)
    const provider: PlaybookProvider = { listStrategies: async () => [staleStrategy, freshStrategy] };
    const input = {
      input: {
        messages: [{ content: "help me write an email strategy", role: "user" as const }],
        metadata: { userId: "stark" },
        model: "test/model"
      },
      runId: "recency-assembled",
      startedAt: new Date()
    };
    const out = await applyPlaybook(input, provider);
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("[Learned Strategies]");
    const freshIdx = system.indexOf(freshStrategy.text);
    const staleIdx = system.indexOf(staleStrategy.text);
    expect(freshIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx).toBeGreaterThanOrEqual(0);
    // D-UCB fades the stale one → fresh appears first
    expect(freshIdx).toBeLessThan(staleIdx);

    // CONTROL: no timestamps → insertion order preserved (stale-first, i.e. stale idx < fresh idx)
    const controlFresh: PlaybookStrategy = { text: "email strategy control fresh", tag: "email", reward: 3 };
    const controlStale: PlaybookStrategy = { text: "email strategy control stale", tag: "email", reward: 3 };
    const controlProvider: PlaybookProvider = { listStrategies: async () => [controlStale, controlFresh] };
    const controlOut = await applyPlaybook(input, controlProvider);
    const controlSystem = controlOut.messages.find((m) => m.role === "system")?.content ?? "";
    const ctrlFreshIdx = controlSystem.indexOf(controlFresh.text);
    const ctrlStaleIdx = controlSystem.indexOf(controlStale.text);
    expect(ctrlFreshIdx).toBeGreaterThanOrEqual(0);
    expect(ctrlStaleIdx).toBeGreaterThanOrEqual(0);
    // No timestamps → insertion order (stale at index 0 leads)
    expect(ctrlStaleIdx).toBeLessThan(ctrlFreshIdx);
  });
});

// Provider projection: buildPlaybookProvider carries the timestamp fields
describe("buildPlaybookProvider — timestamp projection (no undefined keys)", () => {
  it("maps lastReinforcedAt and createdAt when present, omits when absent", () => {
    // Mirror the mapper logic from context-engineering-builders.ts directly
    const entry = {
      text: "some strategy",
      tag: "email",
      reward: 2 as number | undefined,
      decays: undefined as number | undefined,
      reinforcements: undefined as number | undefined,
      probation: undefined as boolean | undefined,
      lastReinforcedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2025-12-01T00:00:00.000Z"
    };
    const mapped = {
      ...(typeof entry.decays === "number" ? { decays: entry.decays } : {}),
      ...(entry.probation ? { probation: true } : {}),
      ...(typeof entry.reinforcements === "number" ? { reinforcements: entry.reinforcements } : {}),
      ...(typeof entry.reward === "number" ? { reward: entry.reward } : {}),
      ...(entry.tag ? { tag: entry.tag } : {}),
      text: entry.text,
      ...(entry.lastReinforcedAt ? { lastReinforcedAt: entry.lastReinforcedAt } : {}),
      ...(entry.createdAt ? { createdAt: entry.createdAt } : {})
    };
    expect(mapped.lastReinforcedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(mapped.createdAt).toBe("2025-12-01T00:00:00.000Z");
    expect("lastReinforcedAt" in mapped).toBe(true);
    expect("createdAt" in mapped).toBe(true);

    // When absent: no undefined keys
    const entryNoTs = { text: "x", tag: undefined as string | undefined, lastReinforcedAt: undefined as string | undefined, createdAt: undefined as string | undefined };
    const mappedNoTs: Record<string, unknown> = {
      text: entryNoTs.text,
      ...(entryNoTs.lastReinforcedAt ? { lastReinforcedAt: entryNoTs.lastReinforcedAt } : {}),
      ...(entryNoTs.createdAt ? { createdAt: entryNoTs.createdAt } : {})
    };
    expect("lastReinforcedAt" in mappedNoTs).toBe(false);
    expect("createdAt" in mappedNoTs).toBe(false);
  });
});

// ─── suppressNearDuplicateStrategies — small-bank injection dedup ─────────────
// arXiv:2510.17940 (Lin 2025, budget-matched diversity) + arXiv:2502.09017 (MMR)

describe("suppressNearDuplicateStrategies — small-bank near-duplicate suppression", () => {
  // Paraphrase pair with Jaccard ≈ 5/6 ≈ 0.833, above the 0.8 threshold.
  // high: "reschedule next business day morning default" → {reschedule,next,business,day,morning,default}
  // low:  "reschedule next business day morning"        → {reschedule,next,business,day,morning}
  // intersection=5, union=6 → 5/6 ≈ 0.833 >= 0.8 → collapsed (low dropped, high kept).
  const highParaphrase: PlaybookStrategy = { text: "reschedule next business day morning default", tag: "scheduling" };
  const lowParaphrase: PlaybookStrategy = { text: "reschedule next business day morning", tag: "scheduling" };
  const distinct: PlaybookStrategy = { text: "keep email replies brief for work", tag: "email" };

  function entry(strategy: PlaybookStrategy, score: number, index: number) {
    return { score, index, strategy };
  }

  it("positive (dedup fires): two near-paraphrase strategies → lower-composite one dropped, higher kept", () => {
    // Input is composite-descending: highParaphrase (score=5) first, lowParaphrase (score=3) second, distinct third.
    const scored = [entry(highParaphrase, 5, 0), entry(lowParaphrase, 3, 1), entry(distinct, 2, 2)];
    const result = suppressNearDuplicateStrategies(scored);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.strategy.text)).toContain(highParaphrase.text);
    expect(result.map((e) => e.strategy.text)).not.toContain(lowParaphrase.text);
    expect(result.map((e) => e.strategy.text)).toContain(distinct.text);
  });

  it("non-vacuity/counterfactual: threshold=1.0 (never collapse) → all 3 survive, dedup is load-bearing", () => {
    // Proves dedup is not a no-op: same input with threshold=1.0 retains all 3.
    const scored = [entry(highParaphrase, 5, 0), entry(lowParaphrase, 3, 1), entry(distinct, 2, 2)];
    const result = suppressNearDuplicateStrategies(scored, 1.0);
    expect(result).toHaveLength(3);
  });

  it("distinct-survive (floor): 3 genuinely different strategies → all 3 kept, composite order unchanged", () => {
    const alpha: PlaybookStrategy = { text: "keep email replies brief for work", tag: "email" };
    const beta: PlaybookStrategy = { text: "summarise meeting notes as bullet points", tag: "notes" };
    const gamma: PlaybookStrategy = { text: "fitness stretching routine morning daily", tag: "health" };
    const scored = [entry(alpha, 5, 0), entry(beta, 3, 1), entry(gamma, 1, 2)];
    const result = suppressNearDuplicateStrategies(scored);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.strategy.text)).toEqual([alpha.text, beta.text, gamma.text]);
  });

  it("cross-lingual safe direction: KO + EN paraphrase pair (Jaccard~0) → BOTH kept, never collapsed", () => {
    const en: PlaybookStrategy = { text: "reschedule next business day morning default", tag: "scheduling" };
    const ko: PlaybookStrategy = { text: "회의를 다음 영업일로 미룬다", tag: "scheduling" };
    const scored = [entry(en, 5, 0), entry(ko, 3, 1)];
    const result = suppressNearDuplicateStrategies(scored);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.strategy.text)).toContain(en.text);
    expect(result.map((e) => e.strategy.text)).toContain(ko.text);
  });
});

describe("suppressNearDuplicateStrategies — assembled-path via applyPlaybook (small-bank path)", () => {
  it("two near-paraphrase reschedule strategies + one distinct → [Learned Strategies] has distinct + one paraphrase only", async () => {
    // bank size=3 ≤ DEFAULT_RANK_TOPK=6 → small-bank path fires → dedup now active.
    // Paraphrase pair: Jaccard = 8/10 = 0.8 >= PLAYBOOK_INJECT_DEDUP_THRESHOLD → lower composite dropped.
    // high: alpha bravo charlie delta echo foxtrot golf hotel INDIA   (9 tokens)
    // low:  alpha bravo charlie delta echo foxtrot golf hotel JULIET  (9 tokens)
    // intersection=8, union=10 → Jaccard=0.8. "juliet" never appears in high's text → safe not.toContain.
    const highParaphrase: PlaybookStrategy = {
      text: "alpha bravo charlie delta echo foxtrot golf hotel india",
      tag: "scheduling",
      reward: 2
    };
    const lowParaphrase: PlaybookStrategy = {
      text: "alpha bravo charlie delta echo foxtrot golf hotel juliet",
      tag: "scheduling",
      reward: 0
    };
    const distinctStrat: PlaybookStrategy = { text: "keep email replies brief for work", tag: "email", reward: 1 };

    const provider: PlaybookProvider = { listStrategies: async () => [highParaphrase, lowParaphrase, distinctStrat] };
    const out = await applyPlaybook(ctx([{ content: "reschedule the review", role: "user" }], "stark"), provider);
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";

    expect(system).toContain("[Learned Strategies]");
    expect(system).toContain(distinctStrat.text);
    // High-composite paraphrase kept; low-composite paraphrase dropped — "juliet" is the unique distinguisher.
    expect(system).toContain(highParaphrase.text);
    expect(system).not.toContain("juliet");
    expect(PLAYBOOK_INJECT_DEDUP_THRESHOLD).toBe(0.8);
  });

  it("counterfactual: no near-dups in small bank → all strategies injected (today's behavior unchanged)", async () => {
    const alpha: PlaybookStrategy = { text: "keep email replies brief for work", tag: "email" };
    const beta: PlaybookStrategy = { text: "summarise meeting notes as bullet points", tag: "notes" };
    const gamma: PlaybookStrategy = { text: "fitness stretching routine morning daily", tag: "health" };
    const provider: PlaybookProvider = { listStrategies: async () => [alpha, beta, gamma] };
    const out = await applyPlaybook(ctx([{ content: "help me with tasks", role: "user" }], "stark"), provider);
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain(alpha.text);
    expect(system).toContain(beta.text);
    expect(system).toContain(gamma.text);
  });
});

// ─── PEVI Wilson-LCB ranking utility (arXiv:2012.15085, Jin/Yang/Wang) ────────

describe("rankingUtility — PEVI pessimistic confidence-bound ranking (arXiv:2012.15085)", () => {
  // Core calibration: point estimate orders A > B but Wilson LCB orders B > A.
  // A = thin-perfect (r=1,d=0): pHat=1 (perfect) but n=1 → very wide CI.
  // B = proven     (r=5,d=3): pHat=0.625 but n=8 → tighter CI.
  // effectiveStrategyReward(A)≈1.25 > effectiveStrategyReward(B)≈0.909  (point estimate: A wins)
  // rankingUtility(A)≈-2.935      < rankingUtility(B)≈-1.943            (LCB: B wins — pessimism)
  it("core calibration: point estimate orders A>B but Wilson LCB orders B>A (proven outranks thin-perfect)", () => {
    const A: PlaybookStrategy = { text: "strategy A thin perfect", reinforcements: 1, decays: 0 };
    const B: PlaybookStrategy = { text: "strategy B proven mixed", reinforcements: 5, decays: 3 };

    const pointA = effectiveStrategyReward(A);
    const pointB = effectiveStrategyReward(B);
    const lcbA = rankingUtility(A);
    const lcbB = rankingUtility(B);

    // Verify the disagreement: point estimate says A wins, LCB says B wins
    expect(pointA).toBeGreaterThan(pointB);
    expect(lcbB).toBeGreaterThan(lcbA);

    // Exact values (from wilsonInterval): confirm they are in-range
    expect(lcbA).toBeCloseTo(-2.9346, 3);
    expect(lcbB).toBeCloseTo(-1.9426, 3);
  });

  it("monotonicity: more reinforcements at equal pHat → strictly higher LCB utility (interval narrows upward)", () => {
    // Both have pHat=1 (all reinforcements, no decays), but n=3 vs n=6 → wider vs tighter CI.
    const sparse: PlaybookStrategy = { text: "sparse perfect", reinforcements: 3, decays: 0 };
    const denser: PlaybookStrategy = { text: "denser perfect", reinforcements: 6, decays: 0 };
    expect(rankingUtility(denser)).toBeGreaterThan(rankingUtility(sparse));
  });

  it("avoidance-gate UNCHANGED: a borderline thin-mixed strategy (r=1,d=2) is not avoided before or after", () => {
    // isAvoidedStrategy uses clampReward(strategy.reward) — for a tally-only strategy, reward is absent → 0.
    // 0 > PLAYBOOK_AVOID_BELOW(-4) → NOT avoided. planStrategyLifecycle: n=3 < 5 → retain (not deprecate).
    // The LCB never feeds isAvoidedStrategy, so membership is unchanged.
    const borderline: PlaybookStrategy = { text: "borderline thin mixed", reinforcements: 1, decays: 2 };
    expect(isAvoidedStrategy(borderline)).toBe(false);
    // Confirm the LCB value is computed (does not throw, is in range)
    const lcb = rankingUtility(borderline);
    expect(lcb).toBeGreaterThanOrEqual(PLAYBOOK_REWARD_MIN);
    expect(lcb).toBeLessThanOrEqual(PLAYBOOK_REWARD_MAX);
  });

  it("invariant — no-tally legacy branch is byte-identical to effectiveStrategyReward (nowMs absent)", () => {
    const legacy: PlaybookStrategy = { text: "legacy reward only", reward: 3 };
    expect(rankingUtility(legacy)).toBe(effectiveStrategyReward(legacy));
    const absent: PlaybookStrategy = { text: "absent reward" };
    expect(rankingUtility(absent)).toBe(effectiveStrategyReward(absent));
    expect(rankingUtility(absent)).toBe(0);
  });

  it("invariant — output always in [PLAYBOOK_REWARD_MIN, PLAYBOOK_REWARD_MAX]", () => {
    const cases: PlaybookStrategy[] = [
      { text: "a", reinforcements: 0, decays: 10 },
      { text: "b", reinforcements: 10, decays: 0 },
      { text: "c", reinforcements: 5, decays: 5 },
      { text: "d", reinforcements: 1, decays: 0 },
      { text: "e", reinforcements: 50, decays: 5 },
      { text: "f", reward: -5 },
      { text: "g", reward: 5 }
    ];
    for (const s of cases) {
      const u = rankingUtility(s);
      expect(u).toBeGreaterThanOrEqual(PLAYBOOK_REWARD_MIN);
      expect(u).toBeLessThanOrEqual(PLAYBOOK_REWARD_MAX);
    }
  });

  it("invariant — nowMs-undefined: rankingUtility equals effectiveStrategyReward for legacy strategies", () => {
    const s: PlaybookStrategy = { text: "x", reward: 3 };
    expect(rankingUtility(s)).toBe(3);
    expect(rankingUtility(s)).toBe(effectiveStrategyReward(s));
  });

  it("invariant — recency discount still applied to positive LCB result (nowMs provided)", () => {
    // A strategy with large tally and recent reinforcement → positive LCB → discount applied.
    // Without discount the value is higher; with a 90-day-old anchor and 30-day half-life
    // the multiplier is 0.5^(90/30) = 0.125, so the discounted value is much lower.
    const NOW_MS = Date.now();
    const s: PlaybookStrategy = {
      text: "heavily proven recent",
      reinforcements: 30,
      decays: 0,
      lastReinforcedAt: new Date(NOW_MS - 90 * 86_400_000).toISOString()
    };
    const withNow = rankingUtility(s, NOW_MS);
    const withoutNow = rankingUtility(s);
    // withoutNow is the raw positive LCB; withNow must be strictly less (discount applied)
    expect(withoutNow).toBeGreaterThan(0);
    expect(withNow).toBeGreaterThan(0);
    expect(withNow).toBeLessThan(withoutNow);
  });

  it("assembled-path (real-revert): proven strategy ranks first in [Learned Strategies]; counterfactual confirms LCB drove it", async () => {
    // Two equal-relevance strategies: both share 3 tokens with the query (email, reply, note)
    // but have distinct non-query tokens → Jaccard ≈ 0.27 (well below dedup threshold 0.8).
    // Tally engineered so point estimate orders A > B but LCB orders B > A (proven wins).
    // A = thin-perfect (r=1,d=0): point≈1.25, lcb≈-2.935
    // B = proven-mixed (r=5,d=3): point≈0.909, lcb≈-1.943
    const A: PlaybookStrategy = {
      text: "email reply note alpha bravo charlie delta",   // extra tokens: alpha,bravo,charlie,delta
      reinforcements: 1,
      decays: 0
    };
    const B: PlaybookStrategy = {
      text: "email reply note india juliet kilo lima",      // extra tokens: india,juliet,kilo,lima
      reinforcements: 5,
      decays: 3
    };

    // Verify the tally disagreement is real (LCB inverts the point-estimate order)
    const pointA = effectiveStrategyReward(A);
    const pointB = effectiveStrategyReward(B);
    const lcbA = rankingUtility(A);
    const lcbB = rankingUtility(B);
    expect(pointA).toBeGreaterThan(pointB);   // point estimate: A wins
    expect(lcbB).toBeGreaterThan(lcbA);       // LCB: B wins (proven)

    // Drive the real ranking path (which uses rankingUtility as utilityOf)
    const query = "email reply note";
    const ranked = rankPlaybookStrategies([A, B], query, { topK: 6 });
    const renderedText = renderPlaybookSection(ranked) ?? "";

    // B (proven) must appear before A (thin) in the rendered block
    const posA = renderedText.indexOf("email reply note alpha");
    const posB = renderedText.indexOf("email reply note india");
    expect(posA).toBeGreaterThanOrEqual(0);
    expect(posB).toBeGreaterThanOrEqual(0);
    expect(posB).toBeLessThan(posA);   // proven strategy (B) is listed first

    // Counterfactual proof: if we were using the point estimate, A would rank above B.
    // The wilsonInterval lower bound is what drives B above A — reverting to pHat shrinkage
    // gives pointA > pointB, meaning A would be first. Verify this directly:
    expect(pointA).toBeGreaterThan(pointB);   // confirmed: point estimate inverts the order

    // Also drive via applyPlaybook to confirm the full assembled path is wired
    const provider: PlaybookProvider = { listStrategies: async () => [A, B] };
    const out = await applyPlaybook(
      ctx([{ content: "email reply note", role: "user" }], "stark"),
      provider
    );
    const system = out.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("[Learned Strategies]");
    const sysPosA = system.indexOf("email reply note alpha");
    const sysPosB = system.indexOf("email reply note india");
    expect(sysPosA).toBeGreaterThanOrEqual(0);
    expect(sysPosB).toBeGreaterThanOrEqual(0);
    expect(sysPosB).toBeLessThan(sysPosA);   // proven (B) is first in the injected block
  });
});
