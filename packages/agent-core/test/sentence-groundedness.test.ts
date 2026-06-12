import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENTENCE_GROUNDING_FLOOR,
  reportSentenceGroundedness
} from "../src/sentence-groundedness.js";

describe("reportSentenceGroundedness", () => {
  // Confirmed via node probe:
  // lexicalTokens("The cat sat on the mat.") → {cat, sat, mat}
  // lexicalTokens("It hunted mice near the barn.") → {hunted, mice, near, barn}
  // evidence "The cat sat on the mat and hunted mice near the barn." → {cat,sat,mat,hunted,mice,near,barn}
  it("fully supported: every sentence's tokens appear in evidence", () => {
    const answer = "The cat sat on the mat. It hunted mice near the barn.";
    const evidence = ["The cat sat on the mat and hunted mice near the barn."];
    const report = reportSentenceGroundedness(answer, evidence);

    expect(report.sentences.length).toBe(2);
    expect(report.sentences[0].label).toBe("supported");
    expect(report.sentences[0].coverage).toBe(1);
    expect(report.sentences[1].label).toBe("supported");
    expect(report.sentences[1].coverage).toBe(1);
    expect(report.unsupportedCount).toBe(0);
    expect(report.unsupportedFraction).toBe(0);
  });

  // Confirmed: s1 tokens {cat,sat,mat} all in evidence, s2 tokens {dragons,breathe,purple,fire} none in evidence
  it("one fabricated sentence: s1 supported, s2 unsupported", () => {
    const answer = "The cat sat on the mat. Dragons breathe purple fire.";
    const evidence = ["The cat sat on the mat in the room."];
    const report = reportSentenceGroundedness(answer, evidence);

    expect(report.sentences.length).toBe(2);
    expect(report.sentences[0].sentence).toContain("cat");
    expect(report.sentences[0].label).toBe("supported");
    expect(report.sentences[0].coverage).toBe(1);

    expect(report.sentences[1].sentence).toContain("Dragons");
    expect(report.sentences[1].label).toBe("unsupported");
    expect(report.sentences[1].coverage).toBe(0);

    expect(report.unsupportedCount).toBe(1);
    expect(report.unsupportedFraction).toBe(0.5);
  });

  it("empty answer: no sentences, zero counts", () => {
    const report = reportSentenceGroundedness("", ["some evidence here"]);
    expect(report.sentences).toEqual([]);
    expect(report.unsupportedCount).toBe(0);
    expect(report.unsupportedFraction).toBe(0);
  });

  it("empty evidence: every content sentence is unsupported", () => {
    const answer = "The cat sat on the mat. Dragons breathe purple fire.";
    const report = reportSentenceGroundedness(answer, []);

    expect(report.sentences.length).toBe(2);
    for (const s of report.sentences) {
      expect(s.label).toBe("unsupported");
      expect(s.coverage).toBe(0);
    }
    expect(report.unsupportedFraction).toBe(1);
  });

  // Confirmed: "..." → lexicalTokens → empty set; "The cat sat on the mat." → {cat, sat, mat}
  it("punctuation-only sentence is omitted from report and denominator", () => {
    const answer = "The cat sat on the mat. ...";
    const evidence = ["The cat sat on the mat."];
    const report = reportSentenceGroundedness(answer, evidence);

    // Only the real sentence is labelled; "..." produces no content tokens and is skipped
    expect(report.sentences.length).toBe(1);
    expect(report.sentences[0].label).toBe("supported");
    expect(report.unsupportedFraction).toBe(0);
  });

  // Confirmed: "Lions hunt zebras and antelope." → {lions, hunt, zebras, antelope}
  // evidence "lions hunt animals africa" → {lions, hunt, animals, africa}
  // overlap = {lions, hunt} = 2 of 4 → coverage = 0.5 = floor → supported
  it("floor boundary: coverage exactly at floor is supported", () => {
    const sentence = "Lions hunt zebras and antelope.";
    const evidence = ["lions hunt animals africa"];
    const report = reportSentenceGroundedness(sentence, evidence);

    expect(report.sentences.length).toBe(1);
    expect(report.sentences[0].coverage).toBe(0.5);
    expect(report.sentences[0].label).toBe("supported");
    expect(report.unsupportedCount).toBe(0);
  });

  it("diagnostic-only sanity: returns a plain object, no throw on odd input", () => {
    expect(() => reportSentenceGroundedness("   ", [])).not.toThrow();
    expect(() => reportSentenceGroundedness("!!!", ["evidence"])).not.toThrow();

    const result = reportSentenceGroundedness("   ", []);
    expect(result).toHaveProperty("sentences");
    expect(result).toHaveProperty("unsupportedCount");
    expect(result).toHaveProperty("unsupportedFraction");
  });

  it("DEFAULT_SENTENCE_GROUNDING_FLOOR is 0.5", () => {
    expect(DEFAULT_SENTENCE_GROUNDING_FLOOR).toBe(0.5);
  });

  it("custom floor: coverage below custom floor is unsupported", () => {
    // "Lions hunt zebras and antelope." has 0.5 coverage against "lions hunt animals africa"
    // With a stricter floor of 0.75, 0.5 < 0.75 → unsupported
    const sentence = "Lions hunt zebras and antelope.";
    const evidence = ["lions hunt animals africa"];
    const report = reportSentenceGroundedness(sentence, evidence, 0.75);

    expect(report.sentences[0].label).toBe("unsupported");
  });
});
