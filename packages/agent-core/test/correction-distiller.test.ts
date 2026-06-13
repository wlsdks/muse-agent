import { type ModelProvider, type ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  classifyCorrectionContradiction,
  DEFAULT_STRATEGY_VERBATIM_CEILING,
  type CorrectionExchange,
  detectApprovals,
  detectCorrections,
  distillStrategyFromCorrection,
  type SessionTurnLine
} from "../src/index.js";

const t = (role: "user" | "assistant", content: string): SessionTurnLine => ({ content, role });

describe("classifyCorrectionContradiction — polarity gate parse + fail-closed (the autonomous-decay safety seam)", () => {
  const provider = (output: string | Error): Pick<ModelProvider, "generate"> => ({
    generate: async () => { if (output instanceof Error) throw output; return { output } as Awaited<ReturnType<ModelProvider["generate"]>>; }
  });
  const run = (out: string | Error) => classifyCorrectionContradiction("stop X", "do X", { model: "m", modelProvider: provider(out) });

  it("parses each verdict word (case-insensitive, tolerant of surrounding text)", async () => {
    expect(await run("CONTRADICT")).toBe("contradict");
    expect(await run("agree")).toBe("agree");
    expect(await run("The answer is UNRELATED.")).toBe("unrelated");
  });

  it("FAILS CLOSED to 'uncertain' on a model error or an unparseable answer (so it never decays on a guess)", async () => {
    expect(await run(new Error("ollama down"))).toBe("uncertain");
    expect(await run("maybe?")).toBe("uncertain");
    expect(await run("")).toBe("uncertain");
  });

  it("does NOT read a NEGATED contradiction as a contradiction (no phantom decay of a learned strategy)", async () => {
    // regression cases — already worked before this change
    for (const negated of ["NOT CONTRADICT", "does not contradict the rule", "It doesn't contradict.", "no, this does not contradict"]) {
      expect(await run(negated), negated).not.toBe("contradict");
    }
  });

  it("does NOT read contraction-auxiliary negations as a contradiction", async () => {
    // contraction auxiliaries added in hardening: WON'T, CANNOT, CAN'T, etc.
    for (const negated of [
      "WON'T CONTRADICT",
      "CANNOT CONTRADICT",
      "CAN'T CONTRADICT",
      "WOULDN'T CONTRADICT",
      "SHOULDN'T CONTRADICT"
    ]) {
      expect(await run(negated), negated).not.toBe("contradict");
    }
  });

  it("does NOT read negation + intervening words as a contradiction", async () => {
    // up to 2 intervening words between negator and CONTRADICT
    for (const negated of [
      "NO CONTRADICTION",
      "NOT A CONTRADICTION",
      "DOESN'T REALLY CONTRADICT",
      "DOES NOT DIRECTLY CONTRADICT"
    ]) {
      expect(await run(negated), negated).not.toBe("contradict");
    }
  });

  it("still reads a genuine contradiction as 'contradict' (not over-stripped)", async () => {
    for (const genuine of [
      "CONTRADICT",
      "CONTRADICTS",
      "CONTRADICTION",
      "THIS CONTRADICTS THE RULE",
      "YES, CONTRADICT"
    ]) {
      expect(await run(genuine), genuine).toBe("contradict");
    }
  });

  it("pass-through: AGREE → 'agree', UNRELATED → 'unrelated', empty/gibberish → 'uncertain'", async () => {
    expect(await run("AGREE")).toBe("agree");
    expect(await run("UNRELATED")).toBe("unrelated");
    expect(await run("")).toBe("uncertain");
    expect(await run("maybe yes")).toBe("uncertain");
  });

  it("still reads a genuine contradiction and a negated-other verdict correctly", async () => {
    expect(await run("CONTRADICT")).toBe("contradict");
    expect(await run("The rule should be dropped — CONTRADICT")).toBe("contradict");
    expect(await run("AGREE — it does not contradict")).toBe("agree"); // AGREE wins, negation stripped harmlessly
  });
});

describe("detectCorrections — reliable failure signal (ReasoningBank 2509.25140; no LLM self-judge per 2404.17140)", () => {
  it("detects a Korean correction turn that follows an assistant answer", () => {
    const turns = [
      t("user", "회의록 정리해줘"),
      t("assistant", "회의록을 문단으로 정리했습니다: ..."),
      t("user", "그게 아니라 불릿으로 정리해줘")
    ];
    const out = detectCorrections(turns);
    expect(out).toHaveLength(1);
    expect(out[0]!.correction).toContain("불릿");
    expect(out[0]!.priorAnswer).toContain("문단으로");
    expect(out[0]!.request).toContain("회의록 정리");
  });

  it("detects an English correction", () => {
    const turns = [
      t("user", "summarise the notes"),
      t("assistant", "Here is a prose summary ..."),
      t("user", "no, that's not what I meant — use bullet points")
    ];
    const out = detectCorrections(turns);
    expect(out).toHaveLength(1);
    expect(out[0]!.correction).toContain("bullet");
  });

  it("does NOT treat a satisfied/neutral follow-up as a correction", () => {
    const turns = [
      t("user", "summarise the notes"),
      t("assistant", "Here is the summary ..."),
      t("user", "no problem, thanks! can you also email it?")
    ];
    expect(detectCorrections(turns)).toHaveLength(0);
  });

  it("ignores a correction-like first turn with no prior assistant answer", () => {
    expect(detectCorrections([t("user", "that's wrong, fix the build")])).toHaveLength(0);
  });

  it("caps the number of exchanges", () => {
    const turns = [
      t("user", "a"), t("assistant", "A1"), t("user", "아니 다시 해"),
      t("assistant", "A2"), t("user", "틀렸어 다시"),
      t("assistant", "A3"), t("user", "그게 아니라 이렇게")
    ];
    expect(detectCorrections(turns, { maxExchanges: 2 })).toHaveLength(2);
  });

  // Every CORRECTION_PATTERN alternative — a regex typo in any one would let a
  // real correction slip past undistilled (silent playbook-learning miss). Each
  // string was confirmed against the built dist before assertion.
  const CORRECTIONS: readonly string[] = [
    "no, that is the issue", "no it's off",
    "that's wrong", "thats incorrect", "that's not right", "that's not what i wanted",
    "not what I asked",
    "I meant the other one", "I said red", "I asked for json",
    "please redo", "try again", "do it again",
    "not like that",
    "그게 아니라",
    "아니야", "아니라고", "아니에요", "아니요",
    "아니, 그러지 말고", "아니 그건",
    "틀렸어", "틀린 답이야",
    "잘못됐어", "잘못했네", "잘못된 거야", "잘못이야",
    "다시 해줘", "다시 써", "다시 작성", "다시 정리",
    "그거 말고", "그렇게 말고", "그건 말고",
    "내 말은 이거야",
    "별로야", "별로네", "별로다"
  ];
  it.each(CORRECTIONS)("recognises correction phrase %j", (phrase) => {
    expect(detectCorrections([t("user", "req"), t("assistant", "ans"), t("user", phrase)])).toHaveLength(1);
  });

  // Bare "wrong"/"instead" are DELIBERATELY excluded (precision-first: a false
  // positive writes a junk strategy into the playbook).
  const NON_CORRECTIONS: readonly string[] = ["this is wrong", "do this instead", "thanks, also email it", "그래 좋아", "ok sounds good"];
  it.each(NON_CORRECTIONS)("does not misfire on neutral phrase %j", (phrase) => {
    expect(detectCorrections([t("user", "req"), t("assistant", "ans"), t("user", phrase)])).toHaveLength(0);
  });

  describe("role pairing", () => {
    it("requires the prior turn to be an assistant answer (user-after-user is not a correction)", () => {
      expect(detectCorrections([t("user", "q"), t("user", "틀렸어")])).toHaveLength(0);
    });

    it("requires the correcting turn itself to be a user turn (an assistant turn is never a correction)", () => {
      expect(detectCorrections([t("user", "q"), t("assistant", "틀렸어")])).toHaveLength(0);
    });

    it("returns nothing for an empty transcript", () => {
      expect(detectCorrections([])).toHaveLength(0);
    });
  });

  describe("request backfill", () => {
    it("populates request only when the turn two back is a user request", () => {
      const out = detectCorrections([t("user", "REQ"), t("assistant", "A"), t("user", "틀렸어")]);
      expect(out[0]!.request).toBe("REQ");
    });

    it("leaves request undefined when the correction is at index 1 (no room for a prior request)", () => {
      const out = detectCorrections([t("assistant", "A"), t("user", "틀렸어")]);
      expect(out).toHaveLength(1);
      expect(out[0]!.request).toBeUndefined();
    });

    it("leaves request undefined when the turn two back is itself an assistant turn", () => {
      const out = detectCorrections([t("assistant", "X"), t("assistant", "A"), t("user", "틀렸어")]);
      expect(out[0]!.request).toBeUndefined();
    });
  });

  describe("maxExchanges clamping (Math.max(1, trunc(n)) — default 2)", () => {
    const many = [
      t("user", "a"), t("assistant", "A"), t("user", "틀렸어"),
      t("assistant", "B"), t("user", "다시 해"),
      t("assistant", "C"), t("user", "아니야")
    ];
    it("defaults to 2 when unspecified", () => {
      expect(detectCorrections(many)).toHaveLength(2);
    });
    it("clamps 0 up to 1", () => {
      expect(detectCorrections(many, { maxExchanges: 0 })).toHaveLength(1);
    });
    it("clamps a negative up to 1", () => {
      expect(detectCorrections(many, { maxExchanges: -5 })).toHaveLength(1);
    });
    it("truncates a fractional cap toward zero (2.9 -> 2)", () => {
      expect(detectCorrections(many, { maxExchanges: 2.9 })).toHaveLength(2);
    });
    it("returns every exchange when the cap exceeds the count", () => {
      expect(detectCorrections(many, { maxExchanges: 100 })).toHaveLength(3);
    });
  });
});

function stubProvider(output: string): ModelProvider {
  return {
    id: "stub",
    async generate() { return { id: "r", model: "m", output }; },
    async listModels() { return []; },
    async *stream() {}
  };
}

function capturingProvider(output: string): { provider: ModelProvider; last: () => ModelRequest } {
  let captured: ModelRequest | undefined;
  return {
    last: () => {
      if (!captured) throw new Error("generate was never called");
      return captured;
    },
    provider: {
      id: "cap",
      async generate(request) { captured = request; return { id: "r", model: "m", output }; },
      async listModels() { return []; },
      async *stream() {}
    }
  };
}

describe("distillStrategyFromCorrection — corrected exchange → one generalized strategy (ReasoningBank 2509.25140)", () => {
  const exchange: CorrectionExchange = {
    correction: "그게 아니라 불릿으로 정리해줘",
    priorAnswer: "회의록을 문단으로 정리했습니다",
    request: "회의록 정리해줘"
  };

  it("parses a strategy + tag from the model output", async () => {
    const provider = stubProvider("strategy: when asked to summarise, use bullet points not prose\ntag: notes");
    const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: provider });
    expect(out?.text).toContain("bullet points");
    expect(out?.tag).toBe("notes");
  });

  it("omits the tag when the model emits '-' or no tag line", async () => {
    const out = await distillStrategyFromCorrection(exchange, {
      model: "m",
      modelProvider: stubProvider("strategy: keep replies terse\ntag: -")
    });
    expect(out?.text).toBe("keep replies terse");
    expect(out?.tag).toBeUndefined();
  });

  it("returns undefined on empty / unparseable output (fail-soft)", async () => {
    expect(await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("") })).toBeUndefined();
    expect(await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("sorry I cannot") })).toBeUndefined();
  });

  it("returns undefined when the provider throws (fail-soft)", async () => {
    const provider: ModelProvider = {
      id: "boom",
      async generate() { throw new Error("model down"); },
      async listModels() { return []; },
      async *stream() {}
    };
    expect(await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: provider })).toBeUndefined();
  });

  describe("output parsing edges", () => {
    it("matches the strategy/tag labels case-insensitively", async () => {
      const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("STRATEGY: keep it short\nTAG: notes") });
      expect(out).toEqual({ tag: "notes", text: "keep it short" });
    });

    it("parses regardless of line order (tag before strategy)", async () => {
      const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("tag: email\nstrategy: be brief") });
      expect(out).toEqual({ tag: "email", text: "be brief" });
    });

    it("keeps the first strategy line when several are present", async () => {
      const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("strategy: first one\nstrategy: second one") });
      expect(out?.text).toBe("first one");
    });

    it("returns undefined when the strategy value is blank", async () => {
      expect(await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("strategy:    ") })).toBeUndefined();
    });

    it("ignores preamble/trailing prose around the strategy line", async () => {
      const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("Here is the answer:\nstrategy: use bullets\nthanks") });
      expect(out?.text).toBe("use bullets");
    });

    it("drops a blank tag value (keeps the strategy)", async () => {
      const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("strategy: keep terse\ntag:    ") });
      expect(out).toEqual({ text: "keep terse" });
    });

    it("trims surrounding whitespace off both values", async () => {
      const out = await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: stubProvider("strategy:    padded value   \ntag:   notes  ") });
      expect(out).toEqual({ tag: "notes", text: "padded value" });
    });
  });

  describe("request construction", () => {
    it("sends the distiller system prompt first, then the transcript as a user message", async () => {
      const { provider, last } = capturingProvider("strategy: x");
      await distillStrategyFromCorrection(exchange, { model: "qwen", modelProvider: provider });
      const req = last();
      expect(req.model).toBe("qwen");
      expect(req.messages[0]).toMatchObject({ role: "system" });
      expect(req.messages[0]!.content).toContain("reusable working preference");
      expect(req.messages[1]).toMatchObject({ role: "user" });
    });

    it("applies sane defaults (maxOutputTokens 80, temperature 0.3)", async () => {
      const { provider, last } = capturingProvider("strategy: x");
      await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: provider });
      expect(last().maxOutputTokens).toBe(80);
      expect(last().temperature).toBe(0.3);
    });

    it("forwards maxOutputTokens / temperature overrides", async () => {
      const { provider, last } = capturingProvider("strategy: x");
      await distillStrategyFromCorrection(exchange, { model: "m", modelProvider: provider, maxOutputTokens: 200, temperature: 0.9 });
      expect(last().maxOutputTokens).toBe(200);
      expect(last().temperature).toBe(0.9);
    });

    it("redacts every transcript value through the supplied redactor", async () => {
      const { provider, last } = capturingProvider("strategy: x");
      await distillStrategyFromCorrection(
        { correction: "corr", priorAnswer: "ans", request: "req" },
        { model: "m", modelProvider: provider, redact: (s) => `[R:${s}]` }
      );
      expect(last().messages[1]!.content).toBe("user asked: [R:req]\nassistant answered: [R:ans]\nuser corrected: [R:corr]");
    });

    it("omits the 'user asked' line when the exchange carries no request", async () => {
      const { provider, last } = capturingProvider("strategy: x");
      await distillStrategyFromCorrection({ correction: "틀렸어", priorAnswer: "ans" }, { model: "m", modelProvider: provider });
      const transcript = last().messages[1]!.content;
      expect(transcript).toBe("assistant answered: ans\nuser corrected: 틀렸어");
      expect(transcript).not.toContain("user asked:");
    });
  });
});

describe("detectApprovals — the POSITIVE reward signal (RL reinforce; precision-first)", () => {
  const detectOne = (phrase: string) => detectApprovals([t("user", "req"), t("assistant", "ans"), t("user", phrase)]);

  it("detects unambiguous EN + KO endorsements", () => {
    for (const phrase of [
      "perfect, thanks",
      "that's exactly what I wanted",
      "exactly right",
      "nailed it",
      "spot on",
      "love it",
      "that works perfectly",
      "완벽해 고마워",
      "딱 좋아",
      "바로 그거야",
      "그게 맞아",
      "정확해",
      "마음에 들어"
    ]) {
      expect(detectOne(phrase), phrase).toHaveLength(1);
    }
  });

  it("does NOT fire on bare acknowledgement (precision-first: no reward inflation)", () => {
    for (const phrase of ["ok", "okay", "thanks", "good", "좋아", "고마워", "알겠어", "응", "sure"]) {
      expect(detectOne(phrase), phrase).toHaveLength(0);
    }
  });

  it("correction takes precedence: a turn that ALSO corrects is NOT an approval (no contradictory reward+decay)", () => {
    // these match both an approval and a correction pattern; the same exchange
    // must not feed both the reinforce and decay signals at once.
    for (const phrase of ["no, that's not it — though the format is perfect", "그게 아니야, 근데 정확해"]) {
      expect(detectOne(phrase), phrase).toHaveLength(0); // approval suppressed by the correction match
    }
    // sanity: the same turns ARE seen as corrections
    expect(
      detectCorrections([t("user", "req"), t("assistant", "ans"), t("user", "no, that's not it — though the format is perfect")])
    ).toHaveLength(1);
  });

  it("requires the assistant→user pairing and backfills the request", () => {
    expect(detectApprovals([t("user", "q"), t("user", "perfect")])).toHaveLength(0); // no assistant before
    const out = detectApprovals([t("user", "REQ"), t("assistant", "A"), t("user", "perfect")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.request).toBe("REQ");
    expect(out[0]!.approval).toBe("perfect");
  });

  it("caps at maxExchanges", () => {
    const turns = [
      t("user", "q1"), t("assistant", "a1"), t("user", "perfect"),
      t("assistant", "a2"), t("user", "nailed it"),
      t("assistant", "a3"), t("user", "spot on")
    ];
    expect(detectApprovals(turns, { maxExchanges: 2 })).toHaveLength(2);
  });

  it("detects the remaining approval patterns missed above (precision-first reward triggers)", () => {
    // Each APPROVAL_PATTERN is a distinct reward trigger; a silently-broken one
    // is lost reinforcement. Cover the ones the EN+KO set above didn't hit.
    for (const phrase of [
      "that's it",
      "just what I needed",
      "works great",
      "완벽합니다",
      "훌륭해",
      "최고야"
    ]) {
      expect(detectOne(phrase), phrase).toHaveLength(1);
    }
  });

  it("defaults maxExchanges to 2 when unspecified (mirror of detectCorrections)", () => {
    const turns = [
      t("user", "q1"), t("assistant", "a1"), t("user", "perfect"),
      t("assistant", "a2"), t("user", "nailed it"),
      t("assistant", "a3"), t("user", "spot on")
    ];
    expect(detectApprovals(turns)).toHaveLength(2);
  });

  it("clamps maxExchanges with Math.max(1, trunc(n)): 0 and negatives floor to 1, fractions truncate", () => {
    const turns = [
      t("user", "q1"), t("assistant", "a1"), t("user", "perfect"),
      t("assistant", "a2"), t("user", "nailed it"),
      t("assistant", "a3"), t("user", "spot on")
    ];
    expect(detectApprovals(turns, { maxExchanges: 0 })).toHaveLength(1);
    expect(detectApprovals(turns, { maxExchanges: -3 })).toHaveLength(1);
    expect(detectApprovals(turns, { maxExchanges: 2.9 })).toHaveLength(2);
  });

  it("an assistant turn carrying an approval phrase is never itself an approval (role guard)", () => {
    // The detector pairs a USER endorsement onto a prior ASSISTANT answer; an
    // assistant turn that happens to say 'perfect' must not be mistaken for one.
    expect(detectApprovals([t("user", "q"), t("assistant", "perfect, here it is")])).toHaveLength(0);
  });

  describe("request backfill (positive reward needs the originating request, when present)", () => {
    it("populates request only when the turn two back is a user request", () => {
      const out = detectApprovals([t("user", "REQ"), t("assistant", "A"), t("user", "spot on")]);
      expect(out[0]!.request).toBe("REQ");
    });

    it("leaves request undefined when the approval is at index 1 (no room for a prior request)", () => {
      const out = detectApprovals([t("assistant", "A"), t("user", "perfect")]);
      expect(out).toHaveLength(1);
      expect(out[0]!.request).toBeUndefined();
    });

    it("leaves request undefined when the turn two back is itself an assistant turn", () => {
      const out = detectApprovals([t("assistant", "A0"), t("assistant", "A"), t("user", "nailed it")]);
      expect(out).toHaveLength(1);
      expect(out[0]!.request).toBeUndefined();
    });
  });
});

describe("distillStrategyFromCorrection — held-out support gate (parity with preference)", () => {
  const enExchange: CorrectionExchange = {
    correction: "no — give me concise bullet points, not prose",
    priorAnswer: "a long flowing paragraph",
    request: "summarise the doc"
  };
  const bulletKeyed = (t: string): Promise<readonly number[]> => Promise.resolve(/bullet/u.test(t) ? [1, 0] : [0, 1]);

  it("keeps a strategy the correction supports", async () => {
    // Embedder: correction (has "bullet") → [1,0,0]; strategy (no "bullet") → [0.8,0.6,0].
    // Support-gate cosine = 0.8 ≥ 0.50 (grounded). Gist-ceiling cosine = 0.8 < 0.92 (abstracted → kept).
    const groundedAbstractEmbed = (text: string): Promise<readonly number[]> =>
      Promise.resolve(/bullet/u.test(text) ? [1, 0, 0] : [0.8, 0.6, 0]);
    const out = await distillStrategyFromCorrection(enExchange, {
      model: "m", embed: groundedAbstractEmbed,
      modelProvider: stubProvider("strategy: prefer structured concise output\ntag: notes")
    });
    expect(out?.text).toBe("prefer structured concise output");
  });

  it("DROPS an unsupported strategy (cosine below floor)", async () => {
    const out = await distillStrategyFromCorrection(enExchange, {
      model: "m", embed: bulletKeyed, // correction has no "bullet" → [0,1]; strategy below → [0,1]? no — strategy lacks bullet → [0,1] vs corr [0,1] cos1
      modelProvider: stubProvider("strategy: always confirm the meeting time\ntag: scheduling")
    });
    // correction "...bullet points..." → [1,0]; strategy "confirm the meeting time" (no bullet) → [0,1] → cos 0 → drop
    expect(out).toBeUndefined();
  });

  it("fact-restatement guard drops a strategy echoing a number from the correction", async () => {
    const factExchange: CorrectionExchange = { correction: "no, it's at 4pm", priorAnswer: "3pm", request: "when?" };
    const out = await distillStrategyFromCorrection(factExchange, {
      model: "m", embed: () => Promise.resolve([1, 0]),
      modelProvider: stubProvider("strategy: always say the meeting is at 4pm\ntag: scheduling")
    });
    expect(out).toBeUndefined();
  });

  it("no embedder ⇒ no support gate (back-compat): strategy kept", async () => {
    const out = await distillStrategyFromCorrection(enExchange, {
      model: "m",
      modelProvider: stubProvider("strategy: anything goes here\ntag: -")
    });
    expect(out?.text).toBe("anything goes here");
  });
});

describe("distillStrategyFromCorrection — gist ceiling (SIB verbatim-overfit gate)", () => {
  // Exchange where correction = "no — give me concise bullet points, not prose"
  // The default ceiling is DEFAULT_STRATEGY_VERBATIM_CEILING (0.92).
  const exchange: CorrectionExchange = {
    correction: "no — give me concise bullet points, not prose",
    priorAnswer: "a long flowing paragraph",
    request: "summarise the doc"
  };

  // Embedder that returns near-identical vectors → cosine ≈ 1.0 (verbatim)
  const verbatimEmbed = (_t: string): Promise<readonly number[]> => Promise.resolve([1, 0, 0]);

  // Embedder where correction → [1,0,0] and strategy → [0.8,0.6,0] (cosine ≈ 0.8, in [0.50, 0.92))
  const abstractedEmbed = (text: string): Promise<readonly number[]> =>
    Promise.resolve(text.includes("bullet") ? [1, 0, 0] : [0.8, 0.6, 0]);

  // Provider that produces a strategy NOT containing numbers (avoids fact-restatement guard)
  const provider = (strategyText: string) =>
    stubProvider(`strategy: ${strategyText}\ntag: notes`);

  it("DROPS a verbatim strategy (cosine ≥ DEFAULT_STRATEGY_VERBATIM_CEILING)", async () => {
    // verbatimEmbed → cosine(correction, strategy) = 1.0 ≥ 0.92 → drop
    const out = await distillStrategyFromCorrection(exchange, {
      embed: verbatimEmbed,
      model: "m",
      modelProvider: provider("when asked, give concise bullet points not prose")
    });
    expect(out).toBeUndefined();
  });

  it("KEEPS a grounded-but-abstracted strategy (cosine ∈ [0.50, 0.92)) — over-drop guard", async () => {
    // abstractedEmbed: correction (has "bullet") → [1,0,0]; strategy (no "bullet") → [0.8,0.6,0]
    // cosine = 0.8 → in [0.50, 0.92) → keep
    const out = await distillStrategyFromCorrection(exchange, {
      embed: abstractedEmbed,
      model: "m",
      modelProvider: provider("prefer structured output over flowing prose")
    });
    expect(out).not.toBeUndefined();
    expect(out?.text).toBe("prefer structured output over flowing prose");
  });

  it("counterfactual: verbatimCeiling 1.01 (disabled) → verbatim strategy kept; default ceiling → dropped", async () => {
    const opts = {
      embed: verbatimEmbed,
      model: "m",
      modelProvider: provider("when asked, give concise bullet points not prose")
    };
    // Ceiling disabled: cosine 1.0 < 1.01 → NOT dropped
    const kept = await distillStrategyFromCorrection(exchange, { ...opts, verbatimCeiling: 1.01 });
    expect(kept).not.toBeUndefined();
    // Default ceiling: cosine 1.0 ≥ 0.92 → dropped
    const dropped = await distillStrategyFromCorrection(exchange, opts);
    expect(dropped).toBeUndefined();
  });

  it("below-floor still drops (existing support-gate regression unchanged)", async () => {
    // abstractedEmbed: correction (has "bullet") → [1,0,0]; this strategy "confirm the meeting" (no bullet) → [0.8,0.6,0]
    // BUT the SUPPORT gate: correction [1,0,0] vs strategy [0.8,0.6,0] → cosine 0.8 ≥ 0.50 → accept
    // Then gist: 0.8 < 0.92 → keep. So for below-floor we need cosine < 0.50.
    // Use an embed that gives cosine 0 between correction and strategy.
    const zeroEmbed = (text: string): Promise<readonly number[]> =>
      Promise.resolve(text.includes("bullet") ? [1, 0] : [0, 1]);
    const out = await distillStrategyFromCorrection(exchange, {
      embed: zeroEmbed,
      model: "m",
      modelProvider: provider("always confirm the meeting time")
    });
    expect(out).toBeUndefined();
  });

  it("cross-script exempt: gist ceiling code-path guards with comparableScript (ceiling never fires on cross-script)", async () => {
    // Korean correction + English strategy → comparableScript(correction, strategy) = false.
    // The support gate ALSO fails-closed for cross-script (marks unverified → !accept),
    // so the pair is dropped before the ceiling is even checked. The ceiling's own
    // comparableScript guard is the defense-in-depth: even if support gate were bypassed,
    // the ceiling would be skipped for a cross-script pair.
    const koExchange: CorrectionExchange = {
      correction: "아니야, 총알 포인트로 요약해줘",
      priorAnswer: "a long paragraph",
      request: "summarise"
    };
    const out = await distillStrategyFromCorrection(koExchange, {
      embed: verbatimEmbed, // returns identical vectors for all texts (cosine 1.0)
      model: "m",
      modelProvider: provider("prefer structured output over flowing prose")
    });
    // Cross-script → support gate: unverified → !accept → returned undefined (correct).
    // Ceiling is structurally exempt for this pair.
    expect(out).toBeUndefined();
  });

  it("no embedder → no gist gate (back-compat: fail-open)", async () => {
    const out = await distillStrategyFromCorrection(exchange, {
      model: "m",
      modelProvider: provider("use bullet points when summarising")
    });
    // No embed → skips both support gate and gist gate → kept
    expect(out).not.toBeUndefined();
  });

  it("DEFAULT_STRATEGY_VERBATIM_CEILING is exported and equals 0.92", () => {
    expect(DEFAULT_STRATEGY_VERBATIM_CEILING).toBe(0.92);
  });
});
