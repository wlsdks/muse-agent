import { describe, expect, it } from "vitest";

import { detectPolarityMismatch } from "./polarity-mismatch.js";
import { reportSentenceGroundedness } from "./sentence-groundedness.js";

describe("detectPolarityMismatch — negation contradiction the token gate is blind to", () => {
  it("flags opposite negation polarity on a high-overlap claim", () => {
    expect(detectPolarityMismatch("The drug is not effective.", ["The drug is effective."])).toBe(true);
  });
  it("does NOT flag matching polarity (both negated)", () => {
    expect(detectPolarityMismatch("The drug is not effective.", ["The drug is not effective."])).toBe(false);
  });
  it("does NOT flag matching polarity (both affirmative)", () => {
    expect(detectPolarityMismatch("The drug is effective.", ["The drug is effective."])).toBe(false);
  });
  it("catches -n't contractions (isn't vs is)", () => {
    expect(detectPolarityMismatch("The VPN isn't on wg0.", ["The VPN is on wg0."])).toBe(true);
  });
  it("does NOT false-fire on a stray negation in a DIFFERENT evidence sentence", () => {
    expect(detectPolarityMismatch("The drug is effective.", ["The drug is effective. Do not exceed the dose."])).toBe(false);
  });
  it("does NOT fire on low-overlap (unrelated) sentences", () => {
    expect(detectPolarityMismatch("The cat is not hungry.", ["The office VPN MTU is 1380."])).toBe(false);
  });
});

describe("reportSentenceGroundedness — polarity guard downgrades a negated contradiction", () => {
  it("a negated contradiction that token-covers fully is unsupported (was supported)", () => {
    const r = reportSentenceGroundedness("The drug is not effective.", ["The drug is effective."]);
    expect(r.sentences[0]!.label).toBe("unsupported");
  });
  it("a faithful affirmative claim stays supported", () => {
    const r = reportSentenceGroundedness("The drug is effective.", ["The drug is effective."]);
    expect(r.sentences[0]!.label).toBe("supported");
  });
  it("a faithful NEGATED claim (matching evidence negation) stays supported", () => {
    const r = reportSentenceGroundedness("The drug is not effective.", ["The drug is not effective."]);
    expect(r.sentences[0]!.label).toBe("supported");
  });
});
