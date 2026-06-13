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
  produceCouncilReasoning,
  screenCouncilOutliers,
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
