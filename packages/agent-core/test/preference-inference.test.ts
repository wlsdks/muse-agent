import { describe, expect, it } from "vitest";

import { inferPreferenceFromCorrection, parseInferredPreference } from "../src/preference-inference.js";

const exchange = {
  request: "summarise this",
  priorAnswer: "Here is a long paragraph...",
  correction: "no, give me bullet points"
};

function fakeProvider(output: string) {
  return { generate: async () => ({ output }) } as unknown as Parameters<typeof inferPreferenceFromCorrection>[1]["modelProvider"];
}

describe("parseInferredPreference", () => {
  it("parses preference + category + confidence", () => {
    expect(parseInferredPreference("preference: prefers concise, bullet-point answers\ncategory: style\nconfidence: 0.8"))
      .toEqual({ value: "prefers concise, bullet-point answers", category: "style", confidence: 0.8 });
  });
  it("returns undefined on NONE, and on a missing/invalid category (rejects fabricated vacuous traits)", () => {
    expect(parseInferredPreference("NONE")).toBeUndefined();
    // no valid category → undefined (the one-off-factual-fix fabrication mode)
    expect(parseInferredPreference("preference: prefers accurate information\nconfidence: 0.9")).toBeUndefined();
    expect(parseInferredPreference("preference: terse replies\ncategory: -\nconfidence: 9")).toBeUndefined();
  });
  it("clamps confidence for a valid-category preference", () => {
    expect(parseInferredPreference("preference: terse replies\ncategory: style\nconfidence: 9")?.confidence).toBe(1);
  });

  it("treats NONE as a prefix verdict — trailing rationale after NONE still means no preference", () => {
    expect(parseInferredPreference("NONE — this is just a one-off date fix")).toBeUndefined();
    expect(parseInferredPreference("none")).toBeUndefined();
  });

  it("returns undefined when there is no preference line, or the trait is too short to be meaningful", () => {
    expect(parseInferredPreference("category: style\nconfidence: 0.8")).toBeUndefined();
    expect(parseInferredPreference("preference: x\ncategory: style")).toBeUndefined();
  });

  it("REJECTS the vacuous accuracy cluster in KOREAN too (정확/정밀 — the language-mirrored output)", () => {
    expect(parseInferredPreference("preference: 정확하게 말하기를 선호\ncategory: format\nconfidence: 0.8")).toBeUndefined();
    expect(parseInferredPreference("preference: 항상 정확한 정보를 제공\ncategory: style\nconfidence: 0.9")).toBeUndefined();
  });

  it("REJECTS the vacuous accuracy/correctness cluster even WITH a valid category (anti-fabrication honesty guard)", () => {
    // A one-off factual fix makes the small model emit "prefers accurate
    // information" + a real category to satisfy the schema. The vacuous-trait
    // guard must fire INDEPENDENTLY of the category check — every user wants
    // accuracy; it is not a persona trait. Each cluster word must be caught.
    for (const trait of [
      "prefers accurate information",
      "likes correct answers",
      "wants precise replies",
      "values truthful responses",
      "prefers honest answers",
      "wants reliable output",
      "likes up-to-date facts"
    ]) {
      expect(
        parseInferredPreference(`preference: ${trait}\ncategory: style\nconfidence: 0.9`),
        `vacuous trait "${trait}" must be rejected`
      ).toBeUndefined();
    }
    // control: a genuinely stylistic trait that does NOT hit the cluster survives.
    expect(parseInferredPreference("preference: prefers concise replies\ncategory: style\nconfidence: 0.9")).toMatchObject({
      value: "prefers concise replies"
    });
  });

  it("keeps a minimal two-character trait (the floor is `< 2`, not `<= 2`)", () => {
    expect(parseInferredPreference("preference: ok\ncategory: style")?.value).toBe("ok");
  });

  it("rejects an INVALID-but-present category, not only a missing one", () => {
    // The guard is `!categoryRaw || !VALID.includes(categoryRaw)` — a present
    // category that simply isn't one of the five ("bogus") must still be
    // rejected; an && here would wrongly accept it.
    expect(parseInferredPreference("preference: terse replies\ncategory: bogus\nconfidence: 0.5")).toBeUndefined();
  });

  it("accepts each of the five real categories and folds case", () => {
    for (const cat of ["style", "format", "language", "tooling", "workflow"]) {
      expect(parseInferredPreference(`preference: a trait\ncategory: ${cat.toUpperCase()}\nconfidence: 0.5`)?.category).toBe(cat);
    }
  });

  it("defaults confidence to 0.6 when the line is absent or unparseable (never NaN)", () => {
    expect(parseInferredPreference("preference: terse replies\ncategory: style")?.confidence).toBe(0.6);
    expect(parseInferredPreference("preference: terse replies\ncategory: style\nconfidence: high")?.confidence).toBe(0.6);
  });

  it("parses a fractional confidence including a leading-dot form", () => {
    expect(parseInferredPreference("preference: terse replies\ncategory: style\nconfidence: 0.42")?.confidence).toBe(0.42);
    expect(parseInferredPreference("preference: terse replies\ncategory: style\nconfidence: .25")?.confidence).toBe(0.25);
  });
});

describe("inferPreferenceFromCorrection", () => {
  it("infers a preference from the model output", async () => {
    const pref = await inferPreferenceFromCorrection(exchange, {
      model: "qwen3:8b",
      modelProvider: fakeProvider("preference: prefers bullet-point summaries\ncategory: format\nconfidence: 0.75")
    });
    expect(pref).toMatchObject({ value: "prefers bullet-point summaries", category: "format", confidence: 0.75 });
  });
  it("returns undefined for a one-off factual fix (NONE) and is fail-soft", async () => {
    expect(await inferPreferenceFromCorrection(exchange, { model: "m", modelProvider: fakeProvider("NONE") })).toBeUndefined();
    const thrower = { generate: async () => { throw new Error("offline"); } } as unknown as Parameters<typeof inferPreferenceFromCorrection>[1]["modelProvider"];
    expect(await inferPreferenceFromCorrection(exchange, { model: "m", modelProvider: thrower })).toBeUndefined();
  });

  function capturing() {
    const sink: { request?: { messages: { role: string; content: string }[]; temperature?: number; maxOutputTokens?: number; model: string } } = {};
    const modelProvider = {
      generate: async (request: typeof sink.request) => { sink.request = request; return { output: "NONE" }; }
    } as unknown as Parameters<typeof inferPreferenceFromCorrection>[1]["modelProvider"];
    return { modelProvider, sink };
  }

  it("redacts secrets in the correction transcript before the model ever sees them", async () => {
    const { modelProvider, sink } = capturing();
    await inferPreferenceFromCorrection(
      { request: "deploy with sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa", priorAnswer: "done", correction: "no, use the staging key" },
      { model: "m", modelProvider }
    );
    const transcript = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(transcript).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(transcript).toContain("[redacted-anthropic-key]");
  });

  it("omits the 'user asked' line when the exchange has no request", async () => {
    const { modelProvider, sink } = capturing();
    await inferPreferenceFromCorrection(
      { priorAnswer: "a long paragraph", correction: "bullet points please" },
      { model: "m", modelProvider }
    );
    const transcript = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(transcript).not.toContain("user asked:");
    expect(transcript).toContain("assistant answered: a long paragraph");
    expect(transcript).toContain("user corrected: bullet points please");
  });

  it("sends temperature 0.3 / maxOutputTokens 80 by default and honours overrides", async () => {
    const def = capturing();
    await inferPreferenceFromCorrection(exchange, { model: "qwen3:8b", modelProvider: def.modelProvider });
    expect(def.sink.request?.temperature).toBe(0.3);
    expect(def.sink.request?.maxOutputTokens).toBe(80);
    expect(def.sink.request?.model).toBe("qwen3:8b");

    const ov = capturing();
    await inferPreferenceFromCorrection(exchange, {
      model: "m",
      modelProvider: ov.modelProvider,
      temperature: 0,
      maxOutputTokens: 200
    });
    expect(ov.sink.request?.temperature).toBe(0);
    expect(ov.sink.request?.maxOutputTokens).toBe(200);
  });

  it("honours a custom redact over the default", async () => {
    const { modelProvider, sink } = capturing();
    await inferPreferenceFromCorrection(exchange, { model: "m", modelProvider, redact: (t) => `<<${t}>>` });
    const transcript = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(transcript).toContain("user corrected: <<no, give me bullet points>>");
  });
});

describe("inferPreferenceFromCorrection — held-out support gate (SkillOpt propose-and-test)", () => {
  // Fake embedder: "bullet"-bearing text → [1,0], everything else → [0,1], so
  // cosine is 1 when both mention bullets and 0 otherwise.
  const fakeEmbed = (t: string): Promise<readonly number[]> => Promise.resolve(/bullet/u.test(t) ? [1, 0] : [0, 1]);
  const inferred = "preference: prefers bullet-point answers\ncategory: format\nconfidence: 0.8";

  it("keeps a preference the correction semantically SUPPORTS", async () => {
    const pref = await inferPreferenceFromCorrection(exchange, {
      embed: fakeEmbed, model: "m", modelProvider: fakeProvider(inferred)
    });
    expect(pref).toMatchObject({ value: "prefers bullet-point answers", category: "format" });
  });

  it("DROPS a fabricated trait the correction does not support — even though it passes the regex/category guards", async () => {
    const factualFix = { request: "when is the meeting?", priorAnswer: "3pm", correction: "no, it's at 4pm" };
    const pref = await inferPreferenceFromCorrection(factualFix, {
      embed: fakeEmbed, model: "m", modelProvider: fakeProvider(inferred)
    });
    expect(pref).toBeUndefined();
  });

  it("fact-restatement guard: a trait echoing a number from the correction is dropped (even with a supportive embedder)", async () => {
    const factualFix = { request: "when is the meeting?", priorAnswer: "3pm", correction: "no, it's at 4pm" };
    const pref = await inferPreferenceFromCorrection(factualFix, {
      embed: () => Promise.resolve([1, 0]), // would pass the support gate
      model: "m",
      modelProvider: fakeProvider("preference: prefers being told it's 4pm\ncategory: format\nconfidence: 0.8")
    });
    expect(pref).toBeUndefined(); // "4" is shared with the correction → fact-restatement
  });

  it("is fail-closed: an embedder error drops the inference", async () => {
    const pref = await inferPreferenceFromCorrection(exchange, {
      embed: () => Promise.reject(new Error("ollama down")), model: "m", modelProvider: fakeProvider(inferred)
    });
    expect(pref).toBeUndefined();
  });

  it("no embedder ⇒ no gate (back-compat): the preference is kept", async () => {
    const factualFix = { request: "when?", priorAnswer: "3pm", correction: "no, it's at 4pm" };
    const pref = await inferPreferenceFromCorrection(factualFix, { model: "m", modelProvider: fakeProvider(inferred) });
    expect(pref).toMatchObject({ category: "format" });
  });

  it("cross-script (Korean correction + English trait) is fail-closed: the unverifiable trait is DROPPED", async () => {
    // A model that ignored the same-language instruction and emitted an English
    // trait for a Korean correction can't be verified → drop it (lean false-negative).
    const koCorrection = { request: "이거 정리해줘", priorAnswer: "장황한 문단...", correction: "그게 아니라 짧게 핵심만 정리해줘" };
    const scriptKeyed = (t: string): Promise<readonly number[]> => Promise.resolve(/[가-힣]/u.test(t) ? [0, 1] : [1, 0]);
    const pref = await inferPreferenceFromCorrection(koCorrection, {
      embed: scriptKeyed, model: "m", modelProvider: fakeProvider(inferred)
    });
    expect(pref).toBeUndefined();
  });

  it("same-language (Korean correction + Korean trait) is verified and kept", async () => {
    const koCorrection = { request: "이거 정리해줘", priorAnswer: "장황한 문단...", correction: "그게 아니라 짧게 핵심만 정리해줘" };
    const koEmbed = (t: string): Promise<readonly number[]> => Promise.resolve(/[가-힣]/u.test(t) ? [1, 0] : [0, 1]); // both KO → cos 1
    const pref = await inferPreferenceFromCorrection(koCorrection, {
      embed: koEmbed, model: "m", modelProvider: fakeProvider("preference: 간결하게 핵심만 답하기를 선호\ncategory: format\nconfidence: 0.8")
    });
    expect(pref).toMatchObject({ value: "간결하게 핵심만 답하기를 선호", category: "format" });
  });
});
