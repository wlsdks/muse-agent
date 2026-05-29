import { describe, expect, it } from "vitest";

import { detectUserCommitments } from "../src/commitment-detector.js";

describe("detectUserCommitments — rule-only, conservative (EN + KO)", () => {
  it("captures explicit English 'I need/have/got to' commitments as high confidence", () => {
    const found = detectUserCommitments([
      "I need to email Bob about the Q3 report.",
      "Also I have to finish the slides by Friday",
      "I've got to renew my passport"
    ]);
    expect(found.map((c) => c.text)).toEqual([
      "email Bob about the Q3 report",
      "finish the slides by Friday",
      "renew my passport"
    ]);
    expect(found.every((c) => c.confidence === "high")).toBe(true);
  });

  it("marks softer 'I should' as low confidence", () => {
    const [c] = detectUserCommitments(["I should call the dentist"]);
    expect(c).toMatchObject({ text: "call the dentist", confidence: "low", kind: "should" });
  });

  it("captures Korean 해야/하기로 했 commitments", () => {
    const found = detectUserCommitments([
      "내일 회의 자료 준비해야 해",
      "그 사람한테 연락하기로 했어"
    ]);
    expect(found.map((c) => c.kind)).toEqual(["ko-haeya", "ko-plan"]);
    expect(found[0]?.text).toContain("회의 자료 준비");
    expect(found[1]?.text).toContain("연락");
  });

  it("does NOT fire on statements with no commitment", () => {
    expect(detectUserCommitments(["I love this", "what time is it?", "그건 별로야"])).toEqual([]);
  });

  it("does NOT mistake a question for a commitment", () => {
    expect(detectUserCommitments(["Do I need to call the dentist?"])).toEqual([]);
    expect(detectUserCommitments(["Why do I have to do this?"])).toEqual([]);
    expect(detectUserCommitments(["I need to call the dentist?"])).toEqual([]);
    // the same words as a plain statement still fire
    expect(detectUserCommitments(["I need to call the dentist"])).toHaveLength(1);
  });

  it("dedupes the same commitment and caps the count", () => {
    const dup = detectUserCommitments(["I need to water the plants", "I need to water the plants"]);
    expect(dup).toHaveLength(1);

    const many = Array.from({ length: 20 }, (_, i) => `I need to do task number ${i.toString()}`);
    expect(detectUserCommitments(many, { maxCommitments: 5 })).toHaveLength(5);
  });
});
