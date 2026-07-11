import { MUSE_IDENTITY_CORE } from "@muse/prompts";
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

  it("drops an offer that fabricates a NUMBER absent from the facts (anti-fabrication)", async () => {
    // facts carry weekday + "4 of last 5 weeks"; an invented "3pm" / "오후 3시" is
    // a number not in the facts → the offer must be dropped (caller keeps fallback).
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("오후 3시 회의 전에 주간 보고서 초안 잡아둘까요?") })).toBeUndefined();
    expect(await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("Want me to draft it before your 9am standup?") })).toBeUndefined();
  });

  it("keeps an offer whose number is grounded in the facts (a real count echoed back)", async () => {
    // "4" and "5" appear in the facts ("seen 4 of last 5 weeks") → not fabricated.
    const out = await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("지난 5주 중 4주나 보고서를 쓰셨던데, 지금 초안 잡아둘까요?") });
    expect(out).toBe("지난 5주 중 4주나 보고서를 쓰셨던데, 지금 초안 잡아둘까요?");
  });

  it("trims surrounding whitespace from a valid offer", async () => {
    const out = await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("  지금 초안 잡아둘까요?  ") });
    expect(out).toBe("지금 초안 잡아둘까요?");
  });
});

describe("synthesizePatternSuggestion — evidence-clause preservation (fire 13)", () => {
  const timeOfDayInput: PatternSuggestionInput = {
    category: "time-of-day-action",
    confidence: 0.9,
    fallbackSuggestion:
      "You usually edit project notes around 9-12 on Mondays (3 edits across 2 days). Want me to surface the most recent one?",
    groundedFacts: "recurring action: Monday 9-12, area \"project\"; 3× over 2 days"
  };
  const weeklyTaskInput: PatternSuggestionInput = {
    category: "weekly-task",
    confidence: 0.85,
    fallbackSuggestion: "\"Weekly report\" — you usually create this on Mondays (4 times across 3 weeks).",
    groundedFacts: "weekly recurring task on Monday; recent: Weekly report; 4× over 3 weeks"
  };

  it("appends the deterministic evidence clause verbatim when composed prose omits the counts", async () => {
    const out = await synthesizePatternSuggestion(timeOfDayInput, {
      model: "m",
      modelProvider: fakeProvider("월요일 오전마다 프로젝트 노트를 손보시던데, 지금 열어드릴까요?")
    });
    expect(out).toBe("월요일 오전마다 프로젝트 노트를 손보시던데, 지금 열어드릴까요? (3 edits across 2 days)");
  });

  it("appends the weekly-task clause (times/weeks wording) the same way", async () => {
    const out = await synthesizePatternSuggestion(weeklyTaskInput, {
      model: "m",
      modelProvider: fakeProvider("월요일마다 주간 보고서를 챙기시던데, 이번 주도 만들어둘까요?")
    });
    expect(out).toBe("월요일마다 주간 보고서를 챙기시던데, 이번 주도 만들어둘까요? (4 times across 3 weeks)");
  });

  it("leaves composed prose unchanged when both counts are already present (no double clause)", async () => {
    const out = await synthesizePatternSuggestion(timeOfDayInput, {
      model: "m",
      modelProvider: fakeProvider("최근 2일 동안 3번이나 프로젝트 노트를 손보셨던데, 지금 열어드릴까요?")
    });
    expect(out).toBe("최근 2일 동안 3번이나 프로젝트 노트를 손보셨던데, 지금 열어드릴까요?");
  });

  it("still appends the clause when only ONE of the two counts is echoed (partial evidence)", async () => {
    const out = await synthesizePatternSuggestion(timeOfDayInput, {
      model: "m",
      modelProvider: fakeProvider("최근 2일 동안 프로젝트 노트를 손보시던데, 지금 열어드릴까요?")
    });
    expect(out).toBe("최근 2일 동안 프로젝트 노트를 손보시던데, 지금 열어드릴까요? (3 edits across 2 days)");
  });

  it("the anti-fabrication guard still fires FIRST — a fabricated number is dropped, clause is never reached", async () => {
    // "5pm" is not in timeOfDayInput's facts (3, 2 only) — must return
    // undefined, not a clause-appended fabrication.
    const out = await synthesizePatternSuggestion(timeOfDayInput, {
      model: "m",
      modelProvider: fakeProvider("오후 5시 전에 프로젝트 노트를 열어드릴까요?")
    });
    expect(out).toBeUndefined();
  });

  it("does nothing when the fallback carries no evidence clause (hand-authored fallback, unaffected)", async () => {
    // The base `input` fixture's fallbackSuggestion has no "(N x across M y)"
    // shape — no clause to preserve, output passes through untouched.
    const out = await synthesizePatternSuggestion(input, { model: "m", modelProvider: fakeProvider("초안 잡아둘까요?") });
    expect(out).toBe("초안 잡아둘까요?");
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

  it("carries the shared identity core in the system message, plus its own offer-writing task", async () => {
    const { modelProvider, sink } = capturing();
    await synthesizePatternSuggestion(input, { model: "m", modelProvider });
    const system = sink.request?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain(MUSE_IDENTITY_CORE);
    expect(system).toContain("RECURRING");
    expect(system).toContain("Invent NOTHING");
  });
});
