import { describe, expect, it } from "vitest";

import { isApprovalReply } from "./is-approval-reply.js";

describe("isApprovalReply", () => {
  it("accepts bare affirmations (case / punctuation / emoji tolerant)", () => {
    for (const yes of ["yes", "Yes", "YES!", "  yes  ", "yes.", "yep", "yeah", "ok", "okay", "approve", "Approved.", "confirm", "go ahead", "do it", "send it", "👍 yes", "yes 🙏", "sure"]) {
      expect(isApprovalReply(yes), yes).toBe(true);
    }
  });

  it("accepts common Korean affirmations", () => {
    for (const yes of ["응", "네", "예", "그래", "승인", "보내줘"]) {
      expect(isApprovalReply(yes), yes).toBe(true);
    }
  });

  it("rejects a longer sentence that merely contains an affirmation (no false approval)", () => {
    for (const no of [
      "yes but change the subject first",
      "yesterday",
      "why?",
      "what does it say",
      "no",
      "not yet",
      "actually no",
      "ok so what's next",
      "approve the budget doc please" // a request, not a bare approval
    ]) {
      expect(isApprovalReply(no), no).toBe(false);
    }
  });

  it("rejects empty / whitespace / non-string", () => {
    expect(isApprovalReply("")).toBe(false);
    expect(isApprovalReply("   ")).toBe(false);
    expect(isApprovalReply(undefined as unknown as string)).toBe(false);
  });
});
