import { describe, expect, it } from "vitest";

import {
  buildCouncilPrompt,
  buildDebateQuestion,
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
});
