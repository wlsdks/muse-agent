import { describe, expect, it } from "vitest";

import { attributeContributors, defaultShouldOrchestrate, dedupeRolesById, orchestrateAnswer, type OrchestrateOptions } from "../src/orchestrate.js";

// A deterministic fake model: a role proposer (system prompt mentions a lens)
// echoes its role; the aggregator (council synthesis) returns council JSON.
function fakeProvider(failLenses: readonly string[] = [], emptyLenses: readonly string[] = []): OrchestrateOptions["modelProvider"] {
  return {
    async generate(request) {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      const isProposer = /assistant\. Answer the user's question|fact-checker/u.test(system);
      if (isProposer) {
        const lens = /practical/u.test(system) ? "practical" : /thorough/u.test(system) ? "thorough" : "skeptic";
        if (failLenses.includes(lens)) throw new Error(`proposer ${lens} failed`);
        if (emptyLenses.includes(lens)) return { id: "x", model: "fake", output: "" };
        return { id: "x", model: "fake", output: `proposal-from-${lens}` };
      }
      // aggregator (MoA merge) → the single merged answer as plain text
      return { id: "x", model: "fake", output: "merged best answer" };
    }
  };
}

const opts = (over: Partial<OrchestrateOptions> = {}): OrchestrateOptions => ({
  model: "fake",
  modelProvider: fakeProvider(),
  ...over
});

describe("defaultShouldOrchestrate", () => {
  it("keeps trivial / greeting turns single", () => {
    expect(defaultShouldOrchestrate("안녕")).toBe(false);
    expect(defaultShouldOrchestrate("hi")).toBe(false);
    expect(defaultShouldOrchestrate("ㅇㅋ")).toBe(false);
  });
  it("orchestrates substantive questions", () => {
    expect(defaultShouldOrchestrate("좋은 하루 보내는 방법 3가지 알려줘")).toBe(true);
    expect(defaultShouldOrchestrate("How do I parallelize agents?")).toBe(true);
    expect(defaultShouldOrchestrate("이 코드를 리팩터링하는 가장 좋은 방법을 설명해줘")).toBe(true);
  });
});

describe("orchestrateAnswer", () => {
  it("takes the single fast path for a trivial turn", async () => {
    const res = await orchestrateAnswer("안녕", opts());
    expect(res.mode).toBe("single");
    expect(res.proposals).toHaveLength(1);
  });

  it("runs all proposers then synthesizes for a substantive turn", async () => {
    const seen: string[] = [];
    const res = await orchestrateAnswer("에이전트를 병렬화하는 가장 좋은 방법은 무엇인가요?", opts({
      onProposal: (p) => seen.push(p.id)
    }));
    expect(res.mode).toBe("orchestrated");
    expect(res.proposals.map((p) => p.id)).toEqual(["practical", "thorough", "skeptic"]);
    expect(seen.sort()).toEqual(["practical", "skeptic", "thorough"]); // all proposers ran (order may vary)
    expect(res.answer).toBe("merged best answer");
    expect(res.contributors).toEqual(["practical", "thorough", "skeptic"]);
  });

  it("respects an explicit shouldOrchestrate override", async () => {
    const res = await orchestrateAnswer("a long substantive question that would normally orchestrate?", opts({
      shouldOrchestrate: () => false
    }));
    expect(res.mode).toBe("single");
  });

  const substantive = "에이전트를 병렬화하는 가장 좋은 방법은 무엇인가요?";

  it("degrades to the surviving proposers when one fails, and surfaces the failed role", async () => {
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["thorough"]) }));
    expect(res.mode).toBe("orchestrated");
    expect(res.proposals.map((p) => p.id)).toEqual(["practical", "skeptic"]);
    expect(res.failedRoles).toEqual(["thorough"]);
    expect(res.answer).toBe("merged best answer"); // survivors still aggregated
  });

  it("with a single survivor returns its answer directly (no wasted merge call)", async () => {
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["practical", "thorough"]) }));
    expect(res.mode).toBe("orchestrated");
    expect(res.contributors).toEqual(["skeptic"]);
    expect(res.failedRoles).toEqual(["practical", "thorough"]);
    expect(res.answer).toBe("proposal-from-skeptic"); // NOT "merged best answer" → aggregate was skipped
  });

  it("throws (fail-close) when every proposer fails — never returns an empty answer", async () => {
    await expect(
      orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["practical", "thorough", "skeptic"]) }))
    ).rejects.toThrow(/all 3 proposers failed/u);
  });

  it("reports no failedRoles on a clean run", async () => {
    const res = await orchestrateAnswer(substantive, opts());
    expect(res.failedRoles).toBeUndefined();
  });

  it("empty proposer output → failedRoles, not proposals (MAST failure propagation)", async () => {
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider([], ["thorough"]) }));
    expect(res.mode).toBe("orchestrated");
    // The empty proposer must NOT appear in proposals
    expect(res.proposals).toHaveLength(2);
    expect(res.proposals.map((p) => p.id)).not.toContain("thorough");
    // It must appear in failedRoles
    expect(res.failedRoles).toEqual(["thorough"]);
    // The answer still comes from the two good proposers
    expect(res.answer).toBe("merged best answer");
  });

  it("whitespace-only proposer output → failedRoles (treated as degraded)", async () => {
    // Uses a custom provider that returns all-whitespace for the skeptic role
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (/fact-checker/u.test(sys)) return { id: "x", model: "fake", output: "   " };
        if (/practical/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-practical" };
        if (/thorough/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-thorough" };
        return { id: "x", model: "fake", output: "merged best answer" };
      }
    };
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: provider }));
    expect(res.proposals).toHaveLength(2);
    expect(res.proposals.map((p) => p.id)).not.toContain("skeptic");
    expect(res.failedRoles).toContain("skeptic");
  });

  it("all-empty proposers → fail-close throw", async () => {
    await expect(
      orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider([], ["practical", "thorough", "skeptic"]) }))
    ).rejects.toThrow(/all 3 proposers failed/u);
  });

  it("regression: all non-empty proposers produce no spurious failedRoles", async () => {
    const res = await orchestrateAnswer(substantive, opts());
    expect(res.failedRoles).toBeUndefined();
    expect(res.proposals).toHaveLength(3);
  });

  it("aggregator throws → graceful degrade to best single proposal (regression of crash)", async () => {
    // Aggregator is distinguished by its system prompt containing "candidate answers".
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("candidate answers")) throw new Error("aggregator flaked");
        if (/practical/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-practical" };
        if (/thorough/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-thorough" };
        return { id: "x", model: "fake", output: "proposal-from-skeptic" };
      }
    };
    // Before this fix this would reject; now it must resolve.
    await expect(
      orchestrateAnswer(substantive, opts({ modelProvider: provider }))
    ).resolves.toMatchObject({
      mode: "orchestrated",
      answer: "proposal-from-thorough",
      contributors: ["thorough"]
    });
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: provider }));
    expect(res.proposals.map((p) => p.id)).toEqual(["practical", "thorough", "skeptic"]);
  });

  it("aggregator returns empty string → fallback to thorough proposal (existing behavior)", async () => {
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("candidate answers")) return { id: "x", model: "fake", output: "" };
        if (/practical/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-practical" };
        if (/thorough/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-thorough" };
        return { id: "x", model: "fake", output: "proposal-from-skeptic" };
      }
    };
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: provider }));
    expect(res.mode).toBe("orchestrated");
    expect(res.answer).toBe("proposal-from-thorough");
    expect(res.contributors).toEqual(["thorough"]);
  });

  it("aggregator succeeds → normal merged answer flows through (regression)", async () => {
    const res = await orchestrateAnswer(substantive, opts());
    expect(res.mode).toBe("orchestrated");
    expect(res.answer).toBe("merged best answer");
    expect(res.contributors).toEqual(["practical", "thorough", "skeptic"]);
  });
});

describe("attributeContributors", () => {
  it("includes a proposal whose tokens mostly appear in the merged text and excludes one whose tokens are absent", () => {
    const merged = "deploy with docker compose up";
    const proposals = [
      { id: "a", text: "deploy with docker compose up the stack" },
      { id: "b", text: "knit a wool sweater by hand" }
    ];
    expect(attributeContributors(merged, proposals)).toEqual(["a"]);
  });

  it("falls back to all ids when no proposal overlaps the merged text", () => {
    const merged = "completely unrelated output zephyr";
    const proposals = [
      { id: "x", text: "apple cider vinegar recipes" },
      { id: "y", text: "quantum entanglement physics" }
    ];
    expect(new Set(attributeContributors(merged, proposals))).toEqual(new Set(["x", "y"]));
  });

  it("skips empty-token proposals (not a contributor) unless fallback applies", () => {
    const merged = "deploy with docker compose";
    const proposals = [
      { id: "good", text: "deploy with docker compose up" },
      { id: "empty", text: "--- ---" }
    ];
    const result = attributeContributors(merged, proposals);
    expect(result).toContain("good");
    expect(result).not.toContain("empty");
  });
});

describe("orchestrateAnswer — multi-merge attribution", () => {
  it("multi-merge path attributes only the proposers whose text is covered by the merged answer (regression: no over-claim)", async () => {
    // Three roles; the aggregator echoes the alpha + beta content, ignoring gamma.
    const roles = [
      { id: "alpha", systemPrompt: "You are alpha assistant. Answer the user's question directly." },
      { id: "beta",  systemPrompt: "You are beta assistant. Answer the user's question directly." },
      { id: "gamma", systemPrompt: "You are gamma assistant. Answer the user's question directly." }
    ];
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (/alpha assistant/u.test(sys)) return { id: "x", model: "fake", output: "container orchestration with kubernetes scaling" };
        if (/beta assistant/u.test(sys))  return { id: "x", model: "fake", output: "kubernetes scaling container pods horizontally" };
        if (/gamma assistant/u.test(sys)) return { id: "x", model: "fake", output: "bake sourdough bread with levain starter culture" };
        // aggregator: merges alpha+beta language only
        return { id: "x", model: "fake", output: "container orchestration with kubernetes scaling pods horizontally" };
      }
    };
    const res = await orchestrateAnswer(
      "How do I scale containers with kubernetes?",
      { model: "fake", modelProvider: provider, roles, shouldOrchestrate: () => true }
    );
    expect(res.mode).toBe("orchestrated");
    expect(res.proposals.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
    // gamma's text (bread/sourdough) has no overlap with the merged answer — must NOT be a contributor
    const contributors = new Set(res.contributors);
    expect(contributors.has("gamma")).toBe(false);
    expect(contributors.has("alpha")).toBe(true);
    expect(contributors.has("beta")).toBe(true);
    // Exactly two contributors (no over-claim)
    expect(res.contributors).toHaveLength(2);
  });

  it("single-survivor path still returns only that survivor as contributor", async () => {
    const substantive = "에이전트를 병렬화하는 가장 좋은 방법은 무엇인가요?";
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["practical", "thorough"]) }));
    expect(res.contributors).toEqual(["skeptic"]);
  });
});

describe("dedupeRolesById", () => {
  it("preserves length and order when all ids are distinct", () => {
    const roles = [
      { id: "a", systemPrompt: "A" },
      { id: "b", systemPrompt: "B" },
      { id: "c", systemPrompt: "C" }
    ];
    const result = dedupeRolesById(roles);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps first occurrence and drops later duplicates", () => {
    const roles = [
      { id: "a", systemPrompt: "P1" },
      { id: "b", systemPrompt: "B" },
      { id: "a", systemPrompt: "P2" }
    ];
    const result = dedupeRolesById(roles);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.find((r) => r.id === "a")?.systemPrompt).toBe("P1");
  });

  it("returns empty array for empty input", () => {
    expect(dedupeRolesById([])).toEqual([]);
  });
});

describe("orchestrateAnswer — duplicate-role guard", () => {
  it("dedups duplicate-id roles: only one proposer runs per id, proposals have unique ids", async () => {
    const invocations: string[] = [];
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (/dup-role/u.test(sys)) {
          invocations.push("dup");
          return { id: "x", model: "fake", output: `proposal-dup-${invocations.length.toString()}` };
        }
        if (/other-role/u.test(sys)) {
          invocations.push("other");
          return { id: "x", model: "fake", output: "proposal-other" };
        }
        // aggregator
        return { id: "x", model: "fake", output: "merged" };
      }
    };

    const roles = [
      { id: "dup", systemPrompt: "You are dup-role assistant. Answer the user's question directly." },
      { id: "dup", systemPrompt: "You are dup-role assistant. Answer the user's question directly." },
      { id: "other", systemPrompt: "You are other-role assistant. Answer the user's question directly." }
    ];

    const res = await orchestrateAnswer(
      "How do I parallelize agents effectively?",
      { model: "fake", modelProvider: provider, roles, shouldOrchestrate: () => true }
    );

    // exactly 2 proposals: "dup" once + "other"
    expect(res.proposals).toHaveLength(2);
    const proposalIds = res.proposals.map((p) => p.id);
    expect(new Set(proposalIds).size).toBe(proposalIds.length); // all unique
    expect(proposalIds).toContain("dup");
    expect(proposalIds).toContain("other");
  });
});
