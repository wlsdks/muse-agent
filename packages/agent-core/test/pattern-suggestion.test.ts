import { describe, expect, it } from "vitest";

import { synthesizePatternSuggestion, type PatternSuggestionInput } from "../src/pattern-suggestion.js";

const input: PatternSuggestionInput = {
  category: "weekly-task",
  confidence: 0.82,
  fallbackSuggestion: "You often add a report task on Mondays.",
  groundedFacts: "weekday=Monday; recurring task ~ 'weekly report'; seen 4 of last 5 weeks"
};

function fakeProvider(output: string | undefined) {
  return { generate: async () => ({ output }) } as unknown as Parameters<typeof synthesizePatternSuggestion>[1]["modelProvider"];
}

describe("synthesizePatternSuggestion", () => {
  it("returns the composed offer from the model", async () => {
    const out = await synthesizePatternSuggestion(input, {
      model: "qwen3:8b",
      modelProvider: fakeProvider("월요일마다 주간 보고서를 만드시던데, 지금 초안 잡아둘까요?")
    });
    expect(out).toBe("월요일마다 주간 보고서를 만드시던데, 지금 초안 잡아둘까요?");
  });

  it("returns undefined when the model declines (NONE → caller keeps fallback / stays silent)", async () => {
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("NONE") })).toBeUndefined();
  });

  it("is fail-soft on empty output and on a throwing provider", async () => {
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("") })).toBeUndefined();
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider(undefined) })).toBeUndefined();
    const thrower = { generate: async () => { throw new Error("offline"); } } as unknown as Parameters<typeof synthesizePatternSuggestion>[1]["modelProvider"];
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: thrower })).toBeUndefined();
  });

  it("declines on a NONE-prefix verdict and on whitespace-only output (trim → empty)", async () => {
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("NONE — facts too thin") })).toBeUndefined();
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("   \n\t ") })).toBeUndefined();
  });

  it("trims surrounding whitespace from a valid offer", async () => {
    const out = await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("  지금 초안 잡아둘까요?  ") });
    expect(out).toBe("지금 초안 잡아둘까요?");
  });
});

function capturing() {
  const sink: { request?: { messages: { role: string; content: string }[]; temperature?: number; maxOutputTokens?: number; model: string } } = {};
  const modelProvider = {
    generate: async (request: typeof sink.request) => { sink.request = request; return { output: "NONE" }; }
  } as unknown as Parameters<typeof synthesizePatternSuggestion>[1]["modelProvider"];
  return { modelProvider, sink };
}

describe("synthesizePatternSuggestion — prompt body + request wiring", () => {
  it("renders the grounded body with category, 2-decimal confidence, facts, and the draft", async () => {
    const { modelProvider, sink } = capturing();
    await synthesizePatternSuggestion(input, { model: "m", modelProvider });
    const body = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(body).toContain("pattern: weekly-task (confidence 0.82)");
    expect(body).toContain("facts: weekday=Monday; recurring task ~ 'weekly report'; seen 4 of last 5 weeks");
    expect(body).toContain("detector's draft suggestion: You often add a report task on Mondays.");
  });

  it("formats confidence to exactly two decimals", async () => {
    const { modelProvider, sink } = capturing();
    await synthesizePatternSuggestion({ ...input, confidence: 0.5 }, { model: "m", modelProvider });
    expect(sink.request?.messages.find((m) => m.role === "user")?.content).toContain("(confidence 0.50)");
  });

  it("redacts secrets in BOTH the grounded facts and the draft suggestion before the model sees them", async () => {
    const { modelProvider, sink } = capturing();
    await synthesizePatternSuggestion(
      {
        ...input,
        groundedFacts: "key seen in note: sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa",
        fallbackSuggestion: "rotate sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb soon"
      },
      { model: "m", modelProvider }
    );
    const body = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(body).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body).not.toContain("sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(body.match(/\[redacted-anthropic-key\]/gu)?.length).toBe(2);
  });

  it("sends temperature 0.3 / maxOutputTokens 80 by default and honours overrides", async () => {
    const def = capturing();
    await synthesizePatternSuggestion(input, { model: "qwen3:8b", modelProvider: def.modelProvider });
    expect(def.sink.request?.temperature).toBe(0.3);
    expect(def.sink.request?.maxOutputTokens).toBe(80);
    expect(def.sink.request?.model).toBe("qwen3:8b");

    const ov = capturing();
    await synthesizePatternSuggestion(input, { model: "m", modelProvider: ov.modelProvider, temperature: 0, maxOutputTokens: 200 });
    expect(ov.sink.request?.temperature).toBe(0);
    expect(ov.sink.request?.maxOutputTokens).toBe(200);
  });

  it("honours a custom redact over the default", async () => {
    const { modelProvider, sink } = capturing();
    await synthesizePatternSuggestion(input, { model: "m", modelProvider, redact: (t) => `<<${t}>>` });
    const body = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(body).toContain("facts: <<weekday=Monday; recurring task ~ 'weekly report'; seen 4 of last 5 weeks>>");
  });
});
