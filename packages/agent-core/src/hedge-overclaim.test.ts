import { describe, expect, it } from "vitest";

import { detectHedgeOverclaim } from "./hedge-overclaim.js";
import { reportSentenceGroundedness } from "./sentence-groundedness.js";

describe("detectHedgeOverclaim — certainty escalation the token gate misses", () => {
  it("flags a categorical answer over HEDGED evidence (may → does)", () => {
    expect(detectHedgeOverclaim("The migration breaks the build.", ["The migration may break the build."])).toBe(true);
  });
  it("does NOT flag a faithful hedge-preserving answer", () => {
    expect(detectHedgeOverclaim("The migration may break the build.", ["The migration may break the build."])).toBe(false);
  });
  it("does NOT flag a categorical answer over categorical evidence", () => {
    expect(detectHedgeOverclaim("The migration breaks the build.", ["The migration breaks the build."])).toBe(false);
  });
  it("does NOT flag UNDER-claiming (answer hedges a categorical evidence)", () => {
    expect(detectHedgeOverclaim("The migration might break the build.", ["The migration breaks the build."])).toBe(false);
  });
  it("does NOT fire on low-overlap (unrelated) sentences", () => {
    expect(detectHedgeOverclaim("The cat is hungry.", ["The migration may break the build."])).toBe(false);
  });
  it("does NOT false-fire when a hedge sits in a DIFFERENT evidence sentence", () => {
    expect(detectHedgeOverclaim("The migration breaks the build.", ["The migration breaks the build. Results may vary."])).toBe(false);
  });
});

describe("reportSentenceGroundedness — hedge-overclaim guard downgrades a certainty escalation", () => {
  it("a categorical claim over hedged evidence is unsupported (was supported)", () => {
    expect(reportSentenceGroundedness("The migration breaks the build.", ["The migration may break the build."]).sentences[0]!.label).toBe("unsupported");
  });
  it("a faithful hedge-preserving claim stays supported", () => {
    expect(reportSentenceGroundedness("The migration may break the build.", ["The migration may break the build."]).sentences[0]!.label).toBe("supported");
  });
});
