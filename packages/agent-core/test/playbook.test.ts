import { type ModelProvider, type ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  applyPlaybook,
  clampReward,
  createAgentRuntime,
  PLAYBOOK_REWARD_MAX,
  PLAYBOOK_REWARD_MIN,
  rankPlaybookStrategies,
  renderPlaybookSection,
  strategyTextSimilarity,
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
});
