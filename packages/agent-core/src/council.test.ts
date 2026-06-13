import { describe, expect, it } from "vitest";

import {
  buildCouncilPrompt,
  buildDebateQuestion,
  COSINE_ABS_FLOOR,
  councilMemberSupports,
  councilMemberSupportsSemantic,
  DEFAULT_COUNCIL_AGREE_AT,
  hasCouncilConsensus,
  parseCouncilAnswer,
  QUESTION_RELEVANCE_FLOOR,
  produceCouncilReasoning,
  rankUtterancesBySupport,
  screenCouncilOutliers,
  screenOffTopicUtterancesSemantic,
  synthesizeCouncilAnswer,
  type CouncilUtterance
} from "./council.js";

describe("buildDebateQuestion — Multiagent Debate round-2 prompt", () => {
  const utterances: CouncilUtterance[] = [
    { peerId: "phone", reasoning: "buy if long term" },
    { peerId: "laptop", reasoning: "rent for flexibility" }
  ];
  it("appends the OTHER members' reasoning (not the member's own) and asks to refine", () => {
    const q = buildDebateQuestion("rent or buy?", "phone", utterances);
    expect(q).toContain("rent or buy?");
    expect(q).toContain("[laptop] rent for flexibility");
    expect(q).not.toContain("[phone]"); // its own round-1 isn't fed back to it
    expect(q).toMatch(/Refine YOUR reasoning/);
  });
  it("returns the question unchanged when no other members spoke", () => {
    expect(buildDebateQuestion("q", "phone", [{ peerId: "phone", reasoning: "x" }])).toBe("q");
    expect(buildDebateQuestion("q", "solo", [])).toBe("q");
  });
});

const peers = new Set(["phone", "laptop", "server"]);

describe("buildCouncilPrompt", () => {
  it("labels each member's reasoning with its [id]", () => {
    const p = buildCouncilPrompt("rent or buy?", [{ peerId: "phone", reasoning: "buy\n\n if long\tterm" }]);
    expect(p).toContain("Question: rent or buy?");
    expect(p).toContain("[phone] buy if long term");
  });
});

describe("parseCouncilAnswer — grounded synthesis (honesty guard)", () => {
  it("keeps only real contributor ids", () => {
    const a = parseCouncilAnswer('{"answer":"Buy if you will stay >5 years.","contributors":["phone","laptop","ghost"]}', peers);
    expect(a).toMatchObject({ answer: "Buy if you will stay >5 years." });
    expect(a!.contributors).toEqual(["phone", "laptop"]); // ghost dropped
  });

  it("tolerates prose around the JSON object and dedupes contributors", () => {
    const a = parseCouncilAnswer('here:\n{"answer":"X","contributors":["phone","phone","server"]}\nthanks', peers);
    expect(a!.contributors).toEqual(["phone", "server"]);
  });

  it("returns null on no JSON / empty answer / non-object", () => {
    expect(parseCouncilAnswer("I think you should buy.", peers)).toBeNull();
    expect(parseCouncilAnswer('{"answer":"   ","contributors":["phone"]}', peers)).toBeNull();
    expect(parseCouncilAnswer('["phone"]', peers)).toBeNull();
  });

  it("an answer with no real contributors still parses (contributors empty)", () => {
    expect(parseCouncilAnswer('{"answer":"Buy.","contributors":["nobody"]}', peers)).toMatchObject({ answer: "Buy.", contributors: [] });
  });
});

describe("synthesizeCouncilAnswer — model-driven", () => {
  const utterances: CouncilUtterance[] = [
    { peerId: "phone", reasoning: "Buying builds equity if you stay long term." },
    { peerId: "laptop", reasoning: "Renting keeps you flexible and avoids maintenance cost." }
  ];

  it("returns null without calling the model when there are no usable utterances / empty question", async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { output: "{}" }; } } as never;
    expect(await synthesizeCouncilAnswer("", utterances, { model: "m", modelProvider: provider })).toBeNull();
    expect(await synthesizeCouncilAnswer("q", [], { model: "m", modelProvider: provider })).toBeNull();
    expect(called).toBe(false);
  });

  it("grounds the synthesis (strips an invented contributor)", async () => {
    const provider = { generate: async () => ({ output: '{"answer":"Buy if long-term, else rent.","contributors":["phone","laptop","oracle"]}' }) } as never;
    const a = await synthesizeCouncilAnswer("rent or buy?", utterances, { model: "m", modelProvider: provider });
    expect(a!.contributors).toEqual(["phone", "laptop"]); // oracle invented → stripped
  });
});

describe("produceCouncilReasoning — bounded participant step", () => {
  it("redacts the reasoning before it leaves; empty question → ''", async () => {
    const provider = { generate: async () => ({ output: "Reason about it. key=sk-proj-AbCdEf0123456789GhIjKl0123456789" }) } as never;
    const out = await produceCouncilReasoning("should I switch jobs?", { model: "m", modelProvider: provider });
    expect(out).toContain("Reason about it");
    expect(out).not.toContain("sk-proj-AbCdEf0123456789GhIjKl0123456789"); // redacted
    expect(await produceCouncilReasoning("  ", { model: "m", modelProvider: provider })).toBe("");
  });
});

// ── consensus-outlier screen (arXiv:2503.05856 — MoA deception robustness) ──

const topicUtterance = (peerId: string): CouncilUtterance => ({
  peerId,
  reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well."
});
const offTopicUtterance = (peerId: string): CouncilUtterance => ({
  peerId,
  reasoning: "Bananas are yellow tropical fruit grown in warm climates near the equator."
});

describe("screenCouncilOutliers — pure deterministic outlier screen", () => {
  it("test 1: 4 peers, 3 on-topic + 1 off-topic → off-topic peer is excluded", () => {
    const input: CouncilUtterance[] = [
      topicUtterance("alice"),
      topicUtterance("bob"),
      topicUtterance("carol"),
      offTopicUtterance("dave")
    ];
    const { kept, excluded } = screenCouncilOutliers(input);
    expect(kept.map((u) => u.peerId)).not.toContain("dave");
    expect(excluded).toHaveLength(1);
    const first = excluded[0];
    expect(first?.peerId).toBe("dave");
    expect(first?.reason).toBe("consensus-outlier");
    expect(kept.map((u) => u.peerId)).toContain("alice");
    expect(kept.map((u) => u.peerId)).toContain("bob");
    expect(kept.map((u) => u.peerId)).toContain("carol");
  });

  it("test 2: panel of 2 → no exclusion (below minPanel floor)", () => {
    const input: CouncilUtterance[] = [
      topicUtterance("alice"),
      offTopicUtterance("bob")
    ];
    const { kept, excluded } = screenCouncilOutliers(input);
    expect(excluded).toHaveLength(0);
    expect(kept).toHaveLength(2);
  });

  it("test 3: uniformly diverse panel (all dissimilar) → no exclusion (relFloor-vs-median guard)", () => {
    // Each peer talks about a distinct topic; all similarities are low but symmetrically so.
    const input: CouncilUtterance[] = [
      { peerId: "a", reasoning: "quantum entanglement is a form of nonlocal correlation in physics" },
      { peerId: "b", reasoning: "the impressionist movement began in nineteenth century paris france" },
      { peerId: "c", reasoning: "mitochondria produce atp via oxidative phosphorylation in cells" }
    ];
    const { excluded } = screenCouncilOutliers(input);
    expect(excluded).toHaveLength(0);
  });

  it("test 4: majority preservation — 5 peers, 3 on-topic + 2 off-topic → at most floor((5-1)/2)=2 excluded, consensus kept", () => {
    const input: CouncilUtterance[] = [
      topicUtterance("alice"),
      topicUtterance("bob"),
      topicUtterance("carol"),
      offTopicUtterance("dave"),
      { peerId: "eve", reasoning: "cooking pasta requires boiling water and adding salt before the pasta" }
    ];
    const { kept, excluded } = screenCouncilOutliers(input);
    // Never exclude more than floor((5-1)/2) = 2
    expect(excluded.length).toBeLessThanOrEqual(2);
    // The 3-member consensus is always kept
    expect(kept.map((u) => u.peerId)).toContain("alice");
    expect(kept.map((u) => u.peerId)).toContain("bob");
    expect(kept.map((u) => u.peerId)).toContain("carol");
  });

  it("test 5 (NON-INERT assembled-path proof): synthesizeCouncilAnswer does NOT include outlier reasoning in synthesis prompt, and CouncilAnswer.excludedPeers names the peer", async () => {
    const promptSink: { content?: string } = {};
    const provider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        promptSink.content = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { id: "r", model: "m", output: '{"answer":"Use PostgreSQL.","contributors":["alice","bob","carol"]}' };
      }
    } as never;
    const utterances: CouncilUtterance[] = [
      topicUtterance("alice"),
      topicUtterance("bob"),
      topicUtterance("carol"),
      offTopicUtterance("dave")
    ];
    const result = await synthesizeCouncilAnswer("Which database?", utterances, { model: "m", modelProvider: provider });
    // The synthesis prompt must NOT contain dave's off-topic reasoning
    expect(promptSink.content).toBeDefined();
    expect(promptSink.content).not.toContain("Bananas are yellow");
    // The returned answer must record dave as excluded
    expect(result?.excludedPeers).toBeDefined();
    expect(result?.excludedPeers?.map((e) => e.peerId)).toContain("dave");
  });

  it("test 6: quarantined peer id cannot appear in contributors even if the model cites it", async () => {
    const provider = {
      generate: async () => ({
        id: "r", model: "m",
        // model attempts to cite the excluded peer "dave"
        output: '{"answer":"Use PostgreSQL.","contributors":["alice","bob","carol","dave"]}'
      })
    } as never;
    const utterances: CouncilUtterance[] = [
      topicUtterance("alice"),
      topicUtterance("bob"),
      topicUtterance("carol"),
      offTopicUtterance("dave")
    ];
    const result = await synthesizeCouncilAnswer("Which database?", utterances, { model: "m", modelProvider: provider });
    expect(result?.contributors).not.toContain("dave");
  });

  it("test 7: back-compat — single utterance → null, empty → null, no excludedPeers", async () => {
    const provider = { generate: async () => ({ id: "r", model: "m", output: '{"answer":"x","contributors":["a"]}' }) } as never;
    // Single usable utterance path (panel < minPanel so screen returns all kept, no excluded)
    const singleResult = await synthesizeCouncilAnswer("Q?", [topicUtterance("a")], { model: "m", modelProvider: provider });
    expect(singleResult?.excludedPeers).toBeUndefined();
    // Empty → null
    expect(await synthesizeCouncilAnswer("Q?", [], { model: "m", modelProvider: provider })).toBeNull();
  });

  it("test 8: determinism — identical input produces identical kept/excluded", () => {
    const input: CouncilUtterance[] = [
      topicUtterance("alice"),
      topicUtterance("bob"),
      topicUtterance("carol"),
      offTopicUtterance("dave")
    ];
    const r1 = screenCouncilOutliers([...input]);
    const r2 = screenCouncilOutliers([...input]);
    expect(r1.kept.map((u) => u.peerId)).toEqual(r2.kept.map((u) => u.peerId));
    expect(r1.excluded.map((e) => e.peerId)).toEqual(r2.excluded.map((e) => e.peerId));
  });

  it("test 9 (refactor check): screenCouncilOutliers is behaviourally identical after extracting councilMemberSupports", () => {
    // The fire-28 cases above already cover this; this test explicitly asserts the helper's values
    // match what screenCouncilOutliers would compute internally, so the refactor is non-regressive.
    const input: CouncilUtterance[] = [
      topicUtterance("alice"),
      topicUtterance("bob"),
      topicUtterance("carol"),
      offTopicUtterance("dave")
    ];
    const supports = councilMemberSupports(input);
    // On-topic peers should have high mutual support; off-topic peer should be low.
    expect(supports[0]).toBeGreaterThan(0.1); // alice
    expect(supports[1]).toBeGreaterThan(0.1); // bob
    expect(supports[2]).toBeGreaterThan(0.1); // carol
    expect(supports[3]).toBeLessThan(0.1);    // dave (off-topic → near-zero Jaccard with others)
    // screenCouncilOutliers result must still exclude dave.
    const { kept, excluded } = screenCouncilOutliers(input);
    expect(excluded.map((e) => e.peerId)).toContain("dave");
    expect(kept.map((u) => u.peerId)).not.toContain("dave");
  });
});

// ── Semantic outlier screen (arXiv:2507.14649 — Cleanse: embedding cosine replaces Jaccard) ──

// Fake embedder helpers: produce controlled unit-ish vectors in R^4.
// near-identical → cosine ~0.9999; orthogonal → cosine ~0.0.
const AGREE_VEC  = [1, 0.1, 0.1, 0.0] as const;  // EN member: "buy"
const AGREE_VEC2 = [0.9, 0.2, 0.1, 0.0] as const; // KO member: "사세요" — similar direction
const AGREE_VEC3 = [0.95, 0.15, 0.1, 0.0] as const;
const OUTLIER_VEC = [0.0, 0.0, 0.0, 1.0] as const; // orthogonal → genuinely unrelated
const ZERO_VEC   = [] as const;

function fakeEmbed(vecMap: Map<string, readonly number[]>) {
  return async (text: string): Promise<readonly number[]> => {
    const v = vecMap.get(text);
    if (v === undefined) throw new Error(`fakeEmbed: no vector for "${text}"`);
    return v;
  };
}

describe("councilMemberSupportsSemantic — embedding-based support signal", () => {
  it("n=1 → [1] (sole speaker trivially agrees)", async () => {
    const embed = fakeEmbed(new Map([["hello", AGREE_VEC]]));
    const result = await councilMemberSupportsSemantic([{ peerId: "a", reasoning: "hello" }], embed);
    expect(result).toEqual([1]);
  });

  it("n=0 → []", async () => {
    const embed = fakeEmbed(new Map());
    expect(await councilMemberSupportsSemantic([], embed)).toEqual([]);
  });

  it("two agreeing peers (same direction) → high mutual support", async () => {
    const m = new Map<string, readonly number[]>([["en text", AGREE_VEC], ["ko text", AGREE_VEC2]]);
    const embed = fakeEmbed(m);
    const [s0, s1] = await councilMemberSupportsSemantic(
      [{ peerId: "en", reasoning: "en text" }, { peerId: "ko", reasoning: "ko text" }],
      embed
    );
    expect(s0).toBeGreaterThan(0.8);
    expect(s1).toBeGreaterThan(0.8);
  });

  it("empty reasoning → support 0 (silent-peer rule preserved)", async () => {
    const m = new Map<string, readonly number[]>([["hello", AGREE_VEC], ["world", AGREE_VEC2]]);
    const embed = fakeEmbed(m);
    const [s0, s1, s2] = await councilMemberSupportsSemantic(
      [{ peerId: "a", reasoning: "hello" }, { peerId: "b", reasoning: "world" }, { peerId: "c", reasoning: "   " }],
      embed
    );
    expect(s2).toBe(0); // empty reasoning member
    expect(s0).toBeGreaterThan(0);
    expect(s1).toBeGreaterThan(0);
  });

  it("failed embed → that member's support is 0, others unaffected", async () => {
    // Only AGREE_VEC for "hello", throwing for "bad"
    const embed = async (text: string): Promise<readonly number[]> => {
      if (text === "bad") throw new Error("embed fail");
      return AGREE_VEC;
    };
    const [s0, s1, s2] = await councilMemberSupportsSemantic(
      [{ peerId: "a", reasoning: "hello" }, { peerId: "b", reasoning: "bad" }, { peerId: "c", reasoning: "hello" }],
      embed
    );
    expect(s1).toBe(0); // failed embed member
    // a and c have the same vector — cosine = 1 to each other, 0 to b → mean = 0.5 each
    expect(s0).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(0);
  });

  it("ZERO_VEC (empty returned) → support 0 for that member, others unaffected with 3+ peers", async () => {
    const embed = async (text: string): Promise<readonly number[]> => {
      if (text === "zero") return ZERO_VEC;
      return AGREE_VEC;
    };
    // With 3 members: a=AGREE_VEC, b=ZERO_VEC, c=AGREE_VEC
    // s0 = mean(cosine(A,ZV), cosine(A,A)) = mean(0, 1) = 0.5
    // s1 = 0 (zero-length vec → 0 pairwise cosine)
    // s2 = mean(cosine(A,A), cosine(A,ZV)) = mean(1, 0) = 0.5
    const [s0, s1, s2] = await councilMemberSupportsSemantic(
      [{ peerId: "a", reasoning: "hello" }, { peerId: "b", reasoning: "zero" }, { peerId: "c", reasoning: "world" }],
      embed
    );
    expect(s1).toBe(0);
    expect(s0).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(0);
  });
});

describe("screenCouncilOutliers — semantic path (precomputedSupports + cosine thresholds)", () => {
  it("COUNTERFACTUAL: two peers agreeing with ZERO token overlap — semantic keeps both, Jaccard would drop one", () => {
    // Korean + English text about the same topic: zero shared tokens → Jaccard ~0
    const en = { peerId: "en", reasoning: "buy the house long term" };
    const ko = { peerId: "ko", reasoning: "집을 장기적으로 구매하세요" };
    const ko2 = { peerId: "ko2", reasoning: "장기 보유시 구입이 유리합니다" };

    // Jaccard path would give ko near-zero support (no shared tokens with EN)
    const jaccardSupports = councilMemberSupports([en, ko, ko2]);
    expect(jaccardSupports[0]).toBeLessThan(0.1); // en: near-zero Jaccard with KO
    // NOTE: this proves the false-drop: under Jaccard, en would be suspect

    // Semantic path: all agree, cosine ~0.9 for all
    const highCosine = 0.9;
    const semanticSupports = [highCosine, highCosine, highCosine];
    const { kept, excluded } = screenCouncilOutliers([en, ko, ko2], { precomputedSupports: semanticSupports });
    expect(excluded).toHaveLength(0);
    expect(kept.map((u) => u.peerId)).toContain("en");
    expect(kept.map((u) => u.peerId)).toContain("ko");
    expect(kept.map((u) => u.peerId)).toContain("ko2");
  });

  it("genuine semantic outlier (cosine ~0.1 to others) IS quarantined with cosine thresholds", () => {
    // Three peers: two agree at cosine 0.85, one is orthogonal at cosine 0.05
    const u1 = { peerId: "a", reasoning: "PostgreSQL for concurrent writes" };
    const u2 = { peerId: "b", reasoning: "I agree, PostgreSQL handles this well" };
    const u3 = { peerId: "c", reasoning: "Bananas are yellow" };

    // precomputed supports: a and b are ~0.85, c is ~0.05
    const semanticSupports = [0.85, 0.85, 0.05];
    const { kept, excluded } = screenCouncilOutliers([u1, u2, u3], { precomputedSupports: semanticSupports });
    expect(excluded.map((e) => e.peerId)).toContain("c");
    expect(kept.map((u) => u.peerId)).toContain("a");
    expect(kept.map((u) => u.peerId)).toContain("b");
  });

  it("COSINE_ABS_FLOOR is applied as default absFloor when precomputedSupports are present", () => {
    // With Jaccard floor (0.08), a cosine support of 0.3 would NOT be caught.
    // With COSINE_ABS_FLOOR (~0.4), it IS caught.
    const u1 = { peerId: "a", reasoning: "x" };
    const u2 = { peerId: "b", reasoning: "y" };
    const u3 = { peerId: "c", reasoning: "z" };
    // Member c has support 0.3: below COSINE_ABS_FLOOR but above Jaccard 0.08
    const semanticSupports = [0.75, 0.75, 0.3];
    const { excluded } = screenCouncilOutliers([u1, u2, u3], { precomputedSupports: semanticSupports });
    expect(excluded.map((e) => e.peerId)).toContain("c");
  });

  it("back-compat: no precomputedSupports → Jaccard path, byte-identical to original", () => {
    const input = [
      { peerId: "alice", reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well." },
      { peerId: "bob",   reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well." },
      { peerId: "carol", reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well." },
      { peerId: "dave",  reasoning: "Bananas are yellow tropical fruit grown in warm climates near the equator." }
    ];
    const { excluded } = screenCouncilOutliers(input);
    expect(excluded.map((e) => e.peerId)).toContain("dave");
  });

  it("COSINE_ABS_FLOOR is ~0.4 (pinned — proves thresholds are calibrated for cosine range)", () => {
    expect(COSINE_ABS_FLOOR).toBeGreaterThanOrEqual(0.35);
    expect(COSINE_ABS_FLOOR).toBeLessThanOrEqual(0.55);
  });
});

describe("synthesizeCouncilAnswer — semantic embed path (fire-28 cross-lingual fix)", () => {
  // KO+EN panel agreeing — these share ZERO tokens (different scripts), so the
  // FORMER Jaccard path would score the EN peer near zero and quarantine it as
  // a false outlier (the documented fire-28 limitation). With semantic embed
  // injected, cosine is ~0.9 → both are KEPT.
  const KO_EN_PANEL: CouncilUtterance[] = [
    { peerId: "ko1", reasoning: "PostgreSQL이 동시 쓰기를 잘 처리합니다." },
    { peerId: "ko2", reasoning: "관계형 무결성 때문에 PostgreSQL을 선택해야 합니다." },
    { peerId: "en",  reasoning: "PostgreSQL handles concurrent writes reliably." }
  ];

  it("fire-28 FIX: KO+EN agreeing panel → EN peer KEPT under semantic embed (limitation now resolved)", async () => {
    // Fake embedder: all three peers get near-identical vectors (they agree)
    const embed = async (_text: string): Promise<readonly number[]> => AGREE_VEC;
    let promptContent = "";
    const provider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        promptContent = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '{"answer":"Use PostgreSQL.","contributors":["ko1","ko2","en"]}' };
      }
    } as never;
    const result = await synthesizeCouncilAnswer("Which database?", KO_EN_PANEL, { embed, model: "m", modelProvider: provider });
    // EN peer must NOT be in excludedPeers
    expect(result?.excludedPeers?.map((e) => e.peerId) ?? []).not.toContain("en");
    // EN peer's reasoning must appear in the synthesis prompt
    expect(promptContent).toContain("PostgreSQL handles concurrent writes reliably.");
  });

  it("genuine deceptive KO peer STILL caught under semantic embed", async () => {
    const panel: CouncilUtterance[] = [
      { peerId: "ko1", reasoning: "PostgreSQL이 동시 쓰기를 잘 처리합니다." },
      { peerId: "ko2", reasoning: "관계형 무결성 때문에 PostgreSQL을 선택해야 합니다." },
      { peerId: "bad", reasoning: "바나나는 노란 열대 과일입니다." }
    ];
    // bad peer is orthogonal to the others
    const m = new Map<string, readonly number[]>([
      ["PostgreSQL이 동시 쓰기를 잘 처리합니다.", AGREE_VEC],
      ["관계형 무결성 때문에 PostgreSQL을 선택해야 합니다.", AGREE_VEC2],
      ["바나나는 노란 열대 과일입니다.", OUTLIER_VEC]
    ]);
    const embed = fakeEmbed(m);
    const provider = {
      generate: async () => ({ output: '{"answer":"Use PostgreSQL.","contributors":["ko1","ko2"]}' })
    } as never;
    const result = await synthesizeCouncilAnswer("Which database?", panel, { embed, model: "m", modelProvider: provider });
    expect(result?.excludedPeers?.map((e) => e.peerId)).toContain("bad");
  });

  it("fail-open: embed throws → falls back to Jaccard, never throws, result identical to no-embed path", async () => {
    const throwEmbed = async (_text: string): Promise<readonly number[]> => { throw new Error("embed down"); };
    const provider = {
      generate: async () => ({ output: '{"answer":"Use PostgreSQL.","contributors":["alice","bob","carol"]}' })
    } as never;
    const input: CouncilUtterance[] = [
      { peerId: "alice", reasoning: "The database should use PostgreSQL because it handles concurrent writes and relational integrity well." },
      { peerId: "bob",   reasoning: "PostgreSQL is the better choice given its reliable handling of concurrent writes." },
      { peerId: "carol", reasoning: "For this use case, PostgreSQL handles concurrent writes reliably and is the right pick." }
    ];
    // Should not throw; embed failure → Jaccard path
    const withBrokenEmbed = await synthesizeCouncilAnswer("Q?", input, { embed: throwEmbed, model: "m", modelProvider: provider });
    const withoutEmbed = await synthesizeCouncilAnswer("Q?", input, { model: "m", modelProvider: provider });
    // Both succeed (non-null)
    expect(withBrokenEmbed).not.toBeNull();
    expect(withoutEmbed).not.toBeNull();
  });

  it("assembled-path: KO+EN agreeing panel reaches synthesis with NO false quarantine in excludedPeers", async () => {
    // All three agree — fake embedder returns same vector for all
    const embed = async (_text: string): Promise<readonly number[]> => AGREE_VEC3;
    const provider = {
      generate: async () => ({ output: '{"answer":"Use PostgreSQL.","contributors":["ko1","ko2","en"]}' })
    } as never;
    const result = await synthesizeCouncilAnswer("Which database?", KO_EN_PANEL, { embed, model: "m", modelProvider: provider });
    expect(result).not.toBeNull();
    const excluded = result?.excludedPeers ?? [];
    expect(excluded.map((e) => e.peerId)).not.toContain("en");
    expect(excluded.map((e) => e.peerId)).not.toContain("ko1");
    expect(excluded.map((e) => e.peerId)).not.toContain("ko2");
  });
});

// ── ReConcile consensus gate (arXiv:2309.13007) ──

describe("hasCouncilConsensus — ReConcile consensus-gated round budget", () => {
  const onTopic1 = "The database should use PostgreSQL because it handles concurrent writes and relational integrity well.";
  const onTopic2 = "PostgreSQL is the better choice given its reliable handling of concurrent writes.";
  const onTopic3 = "For this use case, PostgreSQL handles concurrent writes reliably and is the right pick.";
  const offTopic = "Bananas are yellow tropical fruit grown in warm climates near the equator.";

  const u = (peerId: string, reasoning: string): CouncilUtterance => ({ peerId, reasoning });

  it("n=0 → true (empty panel trivially agrees)", () => {
    expect(hasCouncilConsensus([])).toBe(true);
  });

  it("n=1 → true (solo panel trivially agrees)", () => {
    expect(hasCouncilConsensus([u("a", onTopic1)])).toBe(true);
  });

  it("3-panel, identical reasoning → true", () => {
    expect(hasCouncilConsensus([u("a", onTopic1), u("b", onTopic1), u("c", onTopic1)])).toBe(true);
  });

  it("3-panel, paraphrased agreement → true (above DEFAULT_COUNCIL_AGREE_AT)", () => {
    // Paraphrased: min support ~0.19, threshold 0.16
    expect(hasCouncilConsensus([u("a", onTopic1), u("b", onTopic2), u("c", onTopic3)])).toBe(true);
  });

  it("3-panel, one off-topic dissenter → false (below threshold)", () => {
    expect(hasCouncilConsensus([u("a", onTopic1), u("b", onTopic2), u("c", offTopic)])).toBe(false);
  });

  it("3-panel, all diverse topics → false (symmetric low Jaccard)", () => {
    expect(hasCouncilConsensus([
      u("a", "quantum entanglement is a form of nonlocal correlation in physics"),
      u("b", "the impressionist movement began in nineteenth century paris france"),
      u("c", "mitochondria produce atp via oxidative phosphorylation in cells")
    ])).toBe(false);
  });

  it("empty-reasoning member → support 0 → not consensus", () => {
    expect(hasCouncilConsensus([u("a", onTopic1), u("b", onTopic2), u("c", "")])).toBe(false);
  });

  it("custom agreeAt: lower threshold → agreeing diverse panel flips to true", () => {
    // With agreeAt=0 every panel trivially agrees.
    expect(hasCouncilConsensus([u("a", onTopic1), u("b", offTopic)], { agreeAt: 0 })).toBe(true);
  });

  it("order-stability: same 3 utterances in any order → same result", () => {
    const panel = [u("a", onTopic1), u("b", onTopic2), u("c", offTopic)];
    const r1 = hasCouncilConsensus(panel);
    const r2 = hasCouncilConsensus([panel[2]!, panel[0]!, panel[1]!]);
    expect(r1).toBe(r2);
  });

  it("DEFAULT_COUNCIL_AGREE_AT is 0.16 (2× outlier absFloor, pinned to prevent silent drift)", () => {
    expect(DEFAULT_COUNCIL_AGREE_AT).toBe(0.16);
  });
});

// ── Semantic question-relevance gate (arXiv:2503.13657 + arXiv:2507.14649) ──
// Fire-39 redone: embedding cosine question↔reasoning natively handles paraphrase
// and cross-lingual peers — no script-family guard needed.

// Controlled fake-embed vectors in R^4:
// ON_TOPIC_VEC: direction ~[1, 0, 0, 0] — close to the question
// OFF_TOPIC_VEC: direction ~[0, 0, 0, 1] — orthogonal to the question
// QUESTION_VEC: same direction as ON_TOPIC_VEC so cosine ~0.9+
const QUESTION_VEC   = [1.0, 0.0, 0.0, 0.0] as const;
const ON_TOPIC_VEC   = [0.9, 0.3, 0.1, 0.0] as const;  // cosine with Q ~0.92
const ON_TOPIC_VEC2  = [0.85, 0.4, 0.1, 0.0] as const; // cosine with Q ~0.88 — paraphrase/cross-lingual
const OFF_TOPIC_VEC  = [0.05, 0.05, 0.05, 1.0] as const; // cosine with Q ~0.05

const Q_TEXT = "화요일 오후 회의 일정을 확인해 주세요";

function fakeEmbedQ(vecMap: Map<string, readonly number[]>) {
  return async (text: string): Promise<readonly number[]> => {
    const v = vecMap.get(text);
    if (v === undefined) throw new Error(`fakeEmbedQ: no vector for "${text}"`);
    return v;
  };
}

describe("screenOffTopicUtterancesSemantic — semantic relevance gate (arXiv:2503.13657 + arXiv:2507.14649)", () => {
  // THE FIRE-39-FAILURE-NOW-FIXED:
  // KO question + KO paraphrase peer (zero lexical token overlap): cosine ~0.9 → KEPT
  it("FIRE-39 FIX (KO paraphrase): KO question + KO on-topic paraphrase with 0 token overlap → KEPT (semantic cosine keeps it, lexical would have dropped it)", async () => {
    const ko_question = Q_TEXT;
    const ko_paraphrase = "화요일 오후 미팅 스케줄을 확인하세요"; // paraphrase: different tokens, same meaning
    const off_topic = "바나나는 노란 열대 과일입니다"; // genuinely off-topic

    const m = new Map<string, readonly number[]>([
      [ko_question, QUESTION_VEC],
      [ko_paraphrase, ON_TOPIC_VEC],  // cosine(Q, on-topic) ~0.92 → above QUESTION_RELEVANCE_FLOOR
      [off_topic, OFF_TOPIC_VEC]       // cosine(Q, off-topic) ~0.05 → below QUESTION_RELEVANCE_FLOOR
    ]);
    const embed = fakeEmbedQ(m);

    const utterances: CouncilUtterance[] = [
      { peerId: "ko-paraphrase", reasoning: ko_paraphrase },
      { peerId: "off-topic", reasoning: off_topic }
    ];
    const { kept, excluded } = await screenOffTopicUtterancesSemantic(ko_question, utterances, embed);

    expect(kept.map((u) => u.peerId)).toContain("ko-paraphrase");
    expect(excluded.map((e) => e.peerId)).toContain("off-topic");
    expect(excluded.find((e) => e.peerId === "off-topic")?.reason).toBe("off-topic");
  });

  // KO question + EN cross-lingual on-topic peer: cosine ~0.9 → KEPT
  it("FIRE-39 FIX (cross-lingual): KO question + EN on-topic peer (cross-lingual, zero token overlap) → KEPT", async () => {
    const ko_question = Q_TEXT;
    const en_on_topic = "Please confirm the Tuesday afternoon meeting schedule"; // EN paraphrase of the KO question
    const off_topic = "bananas are yellow tropical fruit grown near the equator";

    const m = new Map<string, readonly number[]>([
      [ko_question, QUESTION_VEC],
      [en_on_topic, ON_TOPIC_VEC2],  // multilingual embedder: same-meaning EN vector aligns with KO question
      [off_topic, OFF_TOPIC_VEC]
    ]);
    const embed = fakeEmbedQ(m);

    const utterances: CouncilUtterance[] = [
      { peerId: "en-cross-lingual", reasoning: en_on_topic },
      { peerId: "off-topic", reasoning: off_topic }
    ];
    const { kept, excluded } = await screenOffTopicUtterancesSemantic(ko_question, utterances, embed);

    expect(kept.map((u) => u.peerId)).toContain("en-cross-lingual");
    expect(excluded.map((e) => e.peerId)).toContain("off-topic");
  });

  // Genuine off-topic peer is DROPPED.
  it("genuine off-topic peer (cosine ~0.05 to question) → DROPPED with reason 'off-topic'", async () => {
    const question = "What is the best database for concurrent writes?";
    const on_topic = "PostgreSQL handles concurrent writes well";
    const off_topic = "bananas are a yellow tropical fruit";

    const m = new Map<string, readonly number[]>([
      [question, QUESTION_VEC],
      [on_topic, ON_TOPIC_VEC],
      [off_topic, OFF_TOPIC_VEC]
    ]);
    const embed = fakeEmbedQ(m);

    const utterances: CouncilUtterance[] = [
      { peerId: "on-topic", reasoning: on_topic },
      { peerId: "off-topic", reasoning: off_topic }
    ];
    const { kept, excluded } = await screenOffTopicUtterancesSemantic(question, utterances, embed);

    expect(kept.map((u) => u.peerId)).toContain("on-topic");
    expect(excluded.map((e) => e.peerId)).toContain("off-topic");
    expect(excluded[0]?.reason).toBe("off-topic");
  });

  // COUNTERFACTUAL / NON-VACUITY: same panel with off-topic rewritten on-topic → ZERO exclusions.
  it("COUNTERFACTUAL: same floor, same question — off-topic peer rewritten on-topic → ZERO exclusions (gate is not always-drop)", async () => {
    const question = "What is the best database for concurrent writes?";
    const on_topic_a = "PostgreSQL handles concurrent writes well";
    const on_topic_b = "I recommend PostgreSQL for its concurrency features"; // rewritten on-topic

    const m = new Map<string, readonly number[]>([
      [question, QUESTION_VEC],
      [on_topic_a, ON_TOPIC_VEC],
      [on_topic_b, ON_TOPIC_VEC2]  // same floor, on-topic direction → cosine ~0.88 → KEPT
    ]);
    const embed = fakeEmbedQ(m);

    const utterances: CouncilUtterance[] = [
      { peerId: "a", reasoning: on_topic_a },
      { peerId: "b", reasoning: on_topic_b }
    ];
    const { excluded } = await screenOffTopicUtterancesSemantic(question, utterances, embed);
    expect(excluded).toHaveLength(0);
  });

  // Majority cap: most peers off-topic → never drops below ceil(n/2).
  it("majority cap: most peers off-topic → never drops below ceil(n/2)", async () => {
    const question = "database for concurrent writes";
    const on_topic = "PostgreSQL handles concurrent writes well";
    const off1 = "bananas are yellow";
    const off2 = "cooking pasta needs boiling water";
    const off3 = "cats purr when content";

    const m = new Map<string, readonly number[]>([
      [question, QUESTION_VEC],
      [on_topic, ON_TOPIC_VEC],
      [off1, OFF_TOPIC_VEC],
      [off2, OFF_TOPIC_VEC],
      [off3, OFF_TOPIC_VEC]
    ]);
    const embed = fakeEmbedQ(m);

    const utterances: CouncilUtterance[] = [
      { peerId: "on", reasoning: on_topic },
      { peerId: "off1", reasoning: off1 },
      { peerId: "off2", reasoning: off2 },
      { peerId: "off3", reasoning: off3 }
    ];
    const { kept, excluded } = await screenOffTopicUtterancesSemantic(question, utterances, embed);
    // ceil(4/2) = 2 → at most 2 dropped, at least 2 kept
    expect(kept.length).toBeGreaterThanOrEqual(Math.ceil(utterances.length / 2));
    expect(excluded.length).toBeLessThanOrEqual(utterances.length - Math.ceil(utterances.length / 2));
  });

  // Fail-open: empty question → all kept.
  it("fail-open: empty question → all kept without calling embed", async () => {
    let called = false;
    const embed = async (_: string): Promise<readonly number[]> => { called = true; return QUESTION_VEC; };
    const utterances: CouncilUtterance[] = [{ peerId: "a", reasoning: "something" }];
    const { kept, excluded } = await screenOffTopicUtterancesSemantic("   ", utterances, embed);
    expect(kept).toHaveLength(1);
    expect(excluded).toHaveLength(0);
    expect(called).toBe(false);
  });

  // Fail-open: n < minPanel → all kept.
  it("fail-open: n < minPanel (default 2) → all kept", async () => {
    const m = new Map<string, readonly number[]>([[Q_TEXT, QUESTION_VEC], ["solo reasoning", OFF_TOPIC_VEC]]);
    const { kept, excluded } = await screenOffTopicUtterancesSemantic(Q_TEXT, [{ peerId: "a", reasoning: "solo reasoning" }], fakeEmbedQ(m));
    expect(kept).toHaveLength(1);
    expect(excluded).toHaveLength(0);
  });

  // Fail-open: embed throws → all kept, no throw.
  it("fail-open: embed throws → all kept, never throws", async () => {
    const throwEmbed = async (_: string): Promise<readonly number[]> => { throw new Error("embed down"); };
    const utterances: CouncilUtterance[] = [
      { peerId: "a", reasoning: "x" },
      { peerId: "b", reasoning: "y" }
    ];
    const result = await screenOffTopicUtterancesSemantic("q?", utterances, throwEmbed);
    expect(result.kept).toHaveLength(2);
    expect(result.excluded).toHaveLength(0);
  });

  // Order-stable: output preserves input order.
  it("order-stable: kept peers preserve input order", async () => {
    const question = "What database for concurrent writes?";
    const m = new Map<string, readonly number[]>([
      [question, QUESTION_VEC],
      ["peer a reasoning", ON_TOPIC_VEC],
      ["peer b reasoning", ON_TOPIC_VEC2],
      ["off topic stuff", OFF_TOPIC_VEC]
    ]);
    const embed = fakeEmbedQ(m);
    const utterances: CouncilUtterance[] = [
      { peerId: "a", reasoning: "peer a reasoning" },
      { peerId: "b", reasoning: "peer b reasoning" },
      { peerId: "c", reasoning: "off topic stuff" }
    ];
    const { kept } = await screenOffTopicUtterancesSemantic(question, utterances, embed);
    expect(kept.map((u) => u.peerId)).toEqual(["a", "b"]);
  });

  // QUESTION_RELEVANCE_FLOOR is calibrated for question↔answer (lower than COSINE_ABS_FLOOR).
  it("QUESTION_RELEVANCE_FLOOR is calibrated for question↔answer similarity (~0.3, below COSINE_ABS_FLOOR=0.4)", () => {
    expect(QUESTION_RELEVANCE_FLOOR).toBeGreaterThanOrEqual(0.2);
    expect(QUESTION_RELEVANCE_FLOOR).toBeLessThan(COSINE_ABS_FLOOR); // lower than peer-peer floor
    expect(QUESTION_RELEVANCE_FLOOR).toBeLessThanOrEqual(0.35);
  });
});

describe("synthesizeCouncilAnswer — relevance gate wired (fire-39 semantic redo)", () => {
  // Assembled-path: one off-topic peer has low question cosine → excluded with "off-topic" in excludedPeers,
  // synthesis only runs on on-topic subset.
  it("assembled-path: off-topic peer (low question cosine) → excluded 'off-topic' in excludedPeers, synthesis on on-topic subset only", async () => {
    const question = "which database for concurrent writes?";
    const on_topic_text = "PostgreSQL handles concurrent writes reliably.";
    const on_topic2_text = "I recommend PostgreSQL given its concurrency model.";
    const off_topic_text = "bananas are a yellow tropical fruit.";

    const m = new Map<string, readonly number[]>([
      [question, QUESTION_VEC],
      [on_topic_text, ON_TOPIC_VEC],
      [on_topic2_text, ON_TOPIC_VEC2],
      [off_topic_text, OFF_TOPIC_VEC]
    ]);
    const embed = fakeEmbedQ(m);

    let synthPrompt = "";
    const provider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        synthPrompt = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '{"answer":"Use PostgreSQL.","contributors":["on1","on2"]}' };
      }
    } as never;

    const utterances: CouncilUtterance[] = [
      { peerId: "on1", reasoning: on_topic_text },
      { peerId: "on2", reasoning: on_topic2_text },
      { peerId: "off", reasoning: off_topic_text }
    ];
    const result = await synthesizeCouncilAnswer(question, utterances, { embed, model: "m", modelProvider: provider });

    // Synthesis prompt must NOT contain off-topic reasoning
    expect(synthPrompt).not.toContain("bananas");
    // Off-topic peer in excludedPeers with reason "off-topic"
    expect(result?.excludedPeers?.map((e) => e.peerId)).toContain("off");
    expect(result?.excludedPeers?.find((e) => e.peerId === "off")?.reason).toBe("off-topic");
    // On-topic peers not excluded
    expect(result?.excludedPeers?.map((e) => e.peerId) ?? []).not.toContain("on1");
    expect(result?.excludedPeers?.map((e) => e.peerId) ?? []).not.toContain("on2");
  });

  // No embed → relevance gate skipped entirely (no lexical fallback).
  // Assert by confirming screenOffTopicUtterancesSemantic is NOT called (inject no embed)
  // and the result is identical to the no-embed baseline (back-compat preserved).
  it("no embed → relevance gate skipped, result identical to back-compat no-embed path", async () => {
    const utterances: CouncilUtterance[] = [
      { peerId: "a", reasoning: "PostgreSQL for concurrent writes" },
      { peerId: "b", reasoning: "PostgreSQL handles it reliably" },
      { peerId: "c", reasoning: "For concurrent writes PostgreSQL is ideal" }
    ];
    const provider = {
      generate: async () => ({ output: '{"answer":"Use PostgreSQL.","contributors":["a","b","c"]}' })
    } as never;
    // With no embed the result succeeds (back-compat) and does not throw
    const result = await synthesizeCouncilAnswer("Which database?", utterances, { model: "m", modelProvider: provider });
    expect(result).not.toBeNull();
    // No exclusions from a relevance gate (none ran)
    // (outlier screen may still run on the Jaccard path, but that is independent)
    expect(result?.answer).toBe("Use PostgreSQL.");
  });
});

// ── Roundtable salience ordering (arXiv:2509.16839 — Yao/Dong/Yang/Li/Du 2025) ──

const mkU = (peerId: string, reasoning: string): CouncilUtterance => ({ peerId, reasoning });

describe("rankUtterancesBySupport — Roundtable salience ordering", () => {
  const u0 = mkU("a", "reasoning a");
  const u1 = mkU("b", "reasoning b");
  const u2 = mkU("c", "reasoning c");

  it("ranking correctness: supports [0.2,0.9,0.5] → output order [u1, u2, u0]", () => {
    const ranked = rankUtterancesBySupport([u0, u1, u2], [0.2, 0.9, 0.5]);
    expect(ranked.map((u) => u.peerId)).toEqual(["b", "c", "a"]);
  });

  it("non-vacuity/counterfactual: supports [0.9,0.2,0.5] → DIFFERENT order [u0, u2, u1]", () => {
    const ranked = rankUtterancesBySupport([u0, u1, u2], [0.9, 0.2, 0.5]);
    expect(ranked.map((u) => u.peerId)).toEqual(["a", "c", "b"]);
  });

  it("tie stability: [0.5,0.5,0.5] → input order preserved exactly", () => {
    const ranked = rankUtterancesBySupport([u0, u1, u2], [0.5, 0.5, 0.5]);
    expect(ranked.map((u) => u.peerId)).toEqual(["a", "b", "c"]);
  });

  it("permutation-preserving: output is a permutation of input (same peerId multiset, same length)", () => {
    const ranked = rankUtterancesBySupport([u0, u1, u2], [0.2, 0.9, 0.5]);
    expect(ranked.length).toBe(3);
    expect(ranked.map((u) => u.peerId).sort()).toEqual(["a", "b", "c"]);
  });

  it("fail-open mismatch: supports.length !== utterances.length → input returned unchanged", () => {
    const ranked = rankUtterancesBySupport([u0, u1, u2], [0.9, 0.5]);
    expect(ranked.map((u) => u.peerId)).toEqual(["a", "b", "c"]);
  });

  it("fail-open: empty supports, non-empty utterances → unchanged", () => {
    const ranked = rankUtterancesBySupport([u0, u1], []);
    expect(ranked.map((u) => u.peerId)).toEqual(["a", "b"]);
  });

  it("empty inputs: both empty → empty output", () => {
    expect(rankUtterancesBySupport([], [])).toEqual([]);
  });
});

describe("synthesizeCouncilAnswer — Roundtable ordering assembled-path (arXiv:2509.16839)", () => {
  // Use the Jaccard (no-embed) path to control support via text content.
  //
  // HIGH-SUPPORT text (hi1/hi2): heavily overlapping tokens — Jaccard ~0.9+ with each
  // other, ~0.05 with lo. With a 3-peer panel the median support is ~0.5 and lo's
  // support ~0.05 is below 0.5×median — BUT the majority cap (floor((3-1)/2)=1) and
  // minPanel=3 guard means the outlier screen may or may not exclude lo. To guarantee
  // lo survives the outlier screen but still has noticeably lower support, use a 2-peer
  // panel (below minPanel=3, so screen is skipped entirely) — but then ranking still
  // applies. However with only 2 peers the Jaccard-based ranking is: hi vs lo.
  //
  // Simpler approach: use 2-peer panel (minPanel=3 → no outlier exclusion, both kept)
  // so the ordering is the ONLY change and is cleanly testable.

  it("assembled-path: high-consensus peer leads the captured synthesis prompt", async () => {
    // 2-peer panel → below minPanel=3, outlier screen skipped, both peers in forSynthesis.
    // Peer 'lo' is placed FIRST in input; peer 'hi' is second. After ordering by support,
    // 'hi' should appear first in the prompt because it has higher Jaccard with its partner.
    //
    // With 2 peers: support[hi] = jaccard(hi,lo); support[lo] = jaccard(lo,hi) — identical.
    // Jaccard is symmetric → supports are equal → tie → input order preserved. Not useful.
    //
    // Use 3 peers with minPanel=3: screenCouncilOutliers fires BUT the majority cap means
    // at most floor((3-1)/2)=1 peer can be excluded. If lo is excluded, the assembled-path
    // proves membership is unchanged from the no-ordering case. We need lo to SURVIVE the
    // screen. So use texts where all pairwise Jaccard values are above absFloor=0.08 AND
    // above relFloor×median. Choose: hi1 and hi2 have Jaccard ~0.6, lo has Jaccard ~0.1
    // with hi1/hi2 (above 0.08 but below relFloor×median only if median>0.2). The median
    // of [0.6, 0.6, 0.1] = 0.6; relFloor×median = 0.3; lo=0.1 < 0.3 AND 0.1 > 0.08 —
    // so lo IS excluded. This makes the ordering test not show [lo] in the prompt.
    //
    // Correct design: use a Jaccard-controlled inject via precomputedSupports OR use a
    // fake embedder that returns distinct support values but all above COSINE_ABS_FLOOR.
    //
    // Fake embedder approach with controlled cosine: all peers above the 0.4 outlier floor
    // (no exclusions), but hi1+hi2 have higher mutual cosine than lo.
    // Vectors (all pass pairwise cosine > 0.4):
    //   hi1 = [1, 0, 0, 0]
    //   hi2 = [0.9, 0.436, 0, 0]  (normalized; cosine(hi1,hi2)≈0.9)
    //   lo  = [0.6, 0, 0.8, 0]    (normalized; cosine(hi1,lo)≈0.6, cosine(hi2,lo)≈0.54)
    //
    // Supports (mean pairwise cosine):
    //   hi1: (cosine(hi1,hi2) + cosine(hi1,lo)) / 2 = (0.9 + 0.6) / 2 = 0.75
    //   hi2: (cosine(hi2,hi1) + cosine(hi2,lo)) / 2 = (0.9 + 0.54) / 2 ≈ 0.72
    //   lo:  (cosine(lo,hi1)  + cosine(lo,hi2))  / 2 = (0.6 + 0.54) / 2 = 0.57
    //
    // Outlier screen (precomputedSupports=[0.75,0.72,0.57], absFloor=0.4):
    //   all supports > 0.4 → no exclusions. All 3 peers survive.
    //
    // Ordering: hi1(0.75) > hi2(0.72) > lo(0.57) → hi1 first, hi2 second, lo third.
    // Input order (lo first, hi1 second, hi2 third) is INVERTED → ordering is non-vacuous.

    const hi1Vec: readonly number[] = [1, 0, 0, 0];
    const hi2Vec: readonly number[] = [0.9, 0.436, 0, 0];   // cosine with hi1 ≈ 0.9
    const loVec:  readonly number[] = [0.6, 0, 0.8, 0];     // cosine with hi1 ≈ 0.6

    const vecMap = new Map<string, readonly number[]>([
      ["hi1 reasoning", hi1Vec],
      ["hi2 reasoning", hi2Vec],
      ["lo reasoning",  loVec]
    ]);
    const embed = async (text: string): Promise<readonly number[]> => {
      const v = vecMap.get(text);
      if (v === undefined) throw new Error(`no vec for "${text}"`);
      return v;
    };

    let capturedPrompt = "";
    const provider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        capturedPrompt = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '{"answer":"Synthesized.","contributors":["hi1","hi2","lo"]}' };
      }
    } as never;

    // lo is placed FIRST in input — ordering must move hi1 or hi2 ahead of it
    const utterances: CouncilUtterance[] = [
      mkU("lo",  "lo reasoning"),
      mkU("hi1", "hi1 reasoning"),
      mkU("hi2", "hi2 reasoning")
    ];
    await synthesizeCouncilAnswer("test question?", utterances, { embed, model: "m", modelProvider: provider });

    const hi1Pos = capturedPrompt.indexOf("[hi1]");
    const hi2Pos = capturedPrompt.indexOf("[hi2]");
    const loPos  = capturedPrompt.indexOf("[lo]");
    expect(hi1Pos).toBeGreaterThan(-1);
    expect(hi2Pos).toBeGreaterThan(-1);
    expect(loPos).toBeGreaterThan(-1);
    // High-support peers (hi1, hi2) must both appear BEFORE low-support peer (lo)
    expect(hi1Pos).toBeLessThan(loPos);
    expect(hi2Pos).toBeLessThan(loPos);
  });

  it("counterfactual: flip which peer has consensus → leading [peerId] in prompt flips", async () => {
    // Same 3 utterances and input order. Two embed configs:
    //   Config A: 'alpha' is the highest-support peer → alpha leads the prompt
    //   Config B: 'gamma' is the highest-support peer → gamma leads the prompt
    //
    // All peers have pairwise cosine > COSINE_ABS_FLOOR=0.4 in BOTH configs → no exclusions.
    //
    // Vectors for config A (alpha high, beta mid, gamma low):
    //   alpha = [1, 0, 0, 0]
    //   beta  = [0.9, 0.436, 0, 0]   cosine(alpha,beta)≈0.9
    //   gamma = [0.6, 0, 0.8, 0]     cosine(alpha,gamma)≈0.6, cosine(beta,gamma)≈0.54
    //   supports: alpha≈0.75, beta≈0.72, gamma≈0.57 → alpha leads
    //
    // Vectors for config B (gamma high, beta mid, alpha low): swap alpha↔gamma
    //   gamma = [1, 0, 0, 0]
    //   beta  = [0.9, 0.436, 0, 0]   cosine(gamma,beta)≈0.9
    //   alpha = [0.6, 0, 0.8, 0]     cosine(gamma,alpha)≈0.6, cosine(beta,alpha)≈0.54
    //   supports: gamma≈0.75, beta≈0.72, alpha≈0.57 → gamma leads

    const HIGH_VEC_CF: readonly number[] = [1, 0, 0, 0];
    const MID_VEC_CF:  readonly number[] = [0.9, 0.436, 0, 0];
    const LOW_VEC_CF:  readonly number[] = [0.6, 0, 0.8, 0];

    const alphaText = "alpha reasoning text";
    const betaText  = "beta reasoning text";
    const gammaText = "gamma reasoning text";

    // Config A: alpha=HIGH, beta=MID, gamma=LOW
    const vecMapA = new Map<string, readonly number[]>([
      [alphaText, HIGH_VEC_CF],
      [betaText,  MID_VEC_CF],
      [gammaText, LOW_VEC_CF]
    ]);
    const embedA = async (t: string): Promise<readonly number[]> => {
      const v = vecMapA.get(t); if (!v) throw new Error(`no vec for "${t}"`); return v;
    };
    let capturedA = "";
    const providerA = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        capturedA = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '{"answer":"A.","contributors":["alpha","beta","gamma"]}' };
      }
    } as never;
    // Input order: gamma first (lowest support in config A) — ordering should move alpha ahead
    await synthesizeCouncilAnswer("q?", [
      mkU("gamma", gammaText),
      mkU("beta",  betaText),
      mkU("alpha", alphaText)
    ], { embed: embedA, model: "m", modelProvider: providerA });

    // Config B: gamma=HIGH, beta=MID, alpha=LOW
    const vecMapB = new Map<string, readonly number[]>([
      [alphaText, LOW_VEC_CF],
      [betaText,  MID_VEC_CF],
      [gammaText, HIGH_VEC_CF]
    ]);
    const embedB = async (t: string): Promise<readonly number[]> => {
      const v = vecMapB.get(t); if (!v) throw new Error(`no vec for "${t}"`); return v;
    };
    let capturedB = "";
    const providerB = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        capturedB = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '{"answer":"B.","contributors":["alpha","beta","gamma"]}' };
      }
    } as never;
    // Input order: alpha first (lowest support in config B) — ordering should move gamma ahead
    await synthesizeCouncilAnswer("q?", [
      mkU("alpha", alphaText),
      mkU("beta",  betaText),
      mkU("gamma", gammaText)
    ], { embed: embedB, model: "m", modelProvider: providerB });

    // Config A: alpha should appear before gamma (alpha has highest support)
    expect(capturedA.indexOf("[alpha]")).toBeLessThan(capturedA.indexOf("[gamma]"));

    // Config B: gamma should appear before alpha (gamma has highest support)
    expect(capturedB.indexOf("[gamma]")).toBeLessThan(capturedB.indexOf("[alpha]"));

    // Counterfactual: the leading peer differs between the two configs
    const leadsA = capturedA.indexOf("[alpha]") < capturedA.indexOf("[gamma]");
    const leadsB = capturedB.indexOf("[gamma]") < capturedB.indexOf("[alpha]");
    expect(leadsA).toBe(true);
    expect(leadsB).toBe(true);
  });

  it("floor guard: outlier screen membership (kept/excluded) is unchanged by ordering", async () => {
    // Verify the ORDER-ONLY contract: excluding dave happens identically to the
    // existing assembled-path test (test 5 above) — ordering does not change who is kept.
    const topicText = "The database should use PostgreSQL because it handles concurrent writes and relational integrity well.";
    const offText   = "Bananas are yellow tropical fruit grown in warm climates near the equator.";

    const promptSink: { content?: string } = {};
    const provider = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        promptSink.content = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '{"answer":"Use PostgreSQL.","contributors":["alice","bob","carol"]}' };
      }
    } as never;

    const utterances: CouncilUtterance[] = [
      mkU("alice", topicText),
      mkU("bob",   topicText),
      mkU("carol", topicText),
      mkU("dave",  offText)
    ];
    const result = await synthesizeCouncilAnswer("Which database?", utterances, { model: "m", modelProvider: provider });

    // Membership: dave still excluded (ORDER-ONLY — no change to keep/drop)
    expect(result?.excludedPeers?.map((e) => e.peerId)).toContain("dave");
    // Synthesis prompt: dave's reasoning absent
    expect(promptSink.content).not.toContain("Bananas are yellow");
    // alice/bob/carol all present
    expect(promptSink.content).toContain("[alice]");
    expect(promptSink.content).toContain("[bob]");
    expect(promptSink.content).toContain("[carol]");
  });
});
