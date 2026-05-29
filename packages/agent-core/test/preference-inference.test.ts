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
});
