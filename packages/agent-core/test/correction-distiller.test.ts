import { type ModelProvider, type ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  type CorrectionExchange,
  detectApprovals,
  detectCorrections,
  distillStrategyFromCorrection,
  type SessionTurnLine
} from "../src/index.js";

const t = (role: "user" | "assistant", content: string): SessionTurnLine => ({ content, role });

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
