import { describe, expect, it } from "vitest";

import { isApprovalReply } from "../src/is-approval-reply.js";

describe("isApprovalReply — the consent parser gating a state-changing send (must fail closed on ambiguity)", () => {
  const APPROVALS: readonly string[] = [
    // English bare affirmations
    "yes", "y", "yep", "yeah", "yup", "ya", "sure",
    "ok", "okay", "k", "approve", "approved", "confirm", "confirmed",
    "do it", "go ahead", "go", "send it", "send", "proceed", "accept", "accepted",
    // Korean
    "응", "어", "네", "예", "그래", "그래요", "승인", "보내", "보내줘", "진행"
  ];
  it.each(APPROVALS)("treats the whole-message affirmation %j as approval", (text) => {
    expect(isApprovalReply(text)).toBe(true);
  });

  describe("normalisation (still approval)", () => {
    it.each([
      ["uppercase", "YES"],
      ["mixed case", "Approve"],
      ["leading/trailing spaces", "  yes  "],
      ["trailing punctuation", "yes!"],
      ["trailing period", "approve."],
      ["question mark", "ok?"],
      ["wrapped in parens", "(yes)"],
      ["wrapped in straight quotes", "'yes'"],
      ["wrapped in smart quotes", "“네”"],
      ["collapses internal whitespace", "go  ahead"],
      ["collapses internal whitespace (multi)", "yes   please"],
      ["trailing thumbs-up emoji", "yes 👍"],
      ["leading thumbs-up emoji", "👍 yes"],
      ["leading check emoji", "✅ approve"],
      ["Korean with punctuation", "네!"]
    ])("%s -> approval", (_label, text) => {
      expect(isApprovalReply(text)).toBe(true);
    });
  });

  describe("fail-close: NOT approval", () => {
    it.each([
      ["empty string", ""],
      ["whitespace only", "   "],
      ["bare thumbs-up emoji (strips to empty)", "👍"],
      ["bare check emoji", "✅"],
      ["bare pray emoji", "🙏"],
      ["explicit no", "no"],
      ["nope", "nope"],
      ["cancel", "cancel"],
      ["contraction don't", "don't"],
      ["stop", "stop"],
      // The headline risk: a message that merely CONTAINS an affirmation but
      // adds a qualifier must never count as consent for a send.
      ["affirmation with a qualifier", "yes but change the subject"],
      ["affirmation plus extra words", "yes please send"],
      ["approve with an object", "approve it"],
      ["over-typed yes", "yesss"],
      ["over-typed okay", "okayyy"],
      ["emoji wedged inside the word", "yes👍please"],
      ["Korean affirmation with a qualifier", "네 근데 제목 바꿔"],
      ["Korean later", "나중에"],
      ["Korean hesitation", "글쎄"]
    ])("%s -> not approval", (_label, text) => {
      expect(isApprovalReply(text)).toBe(false);
    });
  });

  it("returns false for non-string input (runtime guard, never throws)", () => {
    expect(isApprovalReply(null as unknown as string)).toBe(false);
    expect(isApprovalReply(undefined as unknown as string)).toBe(false);
    expect(isApprovalReply(123 as unknown as string)).toBe(false);
    expect(isApprovalReply({} as unknown as string)).toBe(false);
  });
});
