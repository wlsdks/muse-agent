import { describe, expect, it } from "vitest";

import { composeChatSystemContent, selectPlaybookSection, topAppliedStrategy } from "./commands-ask.js";

describe("composeChatSystemContent — ACE [Learned Strategies] into the chat-only ask path", () => {
  it("prepends the playbook block before the system prompt", () => {
    const out = composeChatSystemContent("You are Muse.", "[Learned Strategies]\n- keep answers under 4 sentences");
    expect(out).toBe("[Learned Strategies]\n- keep answers under 4 sentences\n\nYou are Muse.");
  });

  it("is a no-op when there are no learned strategies (prompt unchanged)", () => {
    expect(composeChatSystemContent("You are Muse.", undefined)).toBe("You are Muse.");
    expect(composeChatSystemContent("You are Muse.", "")).toBe("You are Muse.");
    expect(composeChatSystemContent("You are Muse.", "   ")).toBe("You are Muse.");
  });
});

describe("selectPlaybookSection — relevance-ranked top-K into the chat-only ask block (ReasoningBank 2509.25140)", () => {
  const bank = [
    { tag: "email", text: "keep work emails under 4 sentences" },
    { tag: "scheduling", text: "when rescheduling, default to the next business day" }
  ];

  it("injects only the relevant strategy when topK is smaller than the bank", () => {
    const out = selectPlaybookSection(bank, "draft an email reply to Sam", 1) ?? "";
    expect(out).toContain("under 4 sentences");
    expect(out).not.toContain("next business day");
  });

  it("keeps the whole small bank, most-relevant first", () => {
    const out = selectPlaybookSection(bank, "push the meeting to a business day", 6) ?? "";
    expect(out).toContain("next business day");
    expect(out).toContain("under 4 sentences");
    expect(out.indexOf("business day")).toBeLessThan(out.indexOf("4 sentences"));
  });

  it("no entries → undefined (no block injected)", () => {
    expect(selectPlaybookSection([], "anything", 6)).toBeUndefined();
  });
});

describe("topAppliedStrategy — the learned preference surfaced as the S6 beat", () => {
  const bank = [
    { tag: "email", text: "keep work emails under 4 sentences", reward: 3 },
    { tag: "scheduling", text: "when rescheduling, default to the next business day", reward: 0 }
  ];

  it("returns the top-ranked injectable strategy for a relevant question", () => {
    expect(topAppliedStrategy(bank, "draft an email reply to Sam", 6)).toContain("under 4 sentences");
  });

  it("matches the head of the injected block (same ranking as selectPlaybookSection)", () => {
    const section = selectPlaybookSection(bank, "push the meeting to a business day", 6) ?? "";
    const top = topAppliedStrategy(bank, "push the meeting to a business day", 6) ?? "";
    expect(top).toContain("next business day");
    expect(section.indexOf(top)).toBeGreaterThanOrEqual(0); // the named strategy IS in the block
  });

  it("undefined for an empty bank and when every entry is excluded (probation/avoided)", () => {
    expect(topAppliedStrategy([], "anything", 6)).toBeUndefined();
    expect(topAppliedStrategy([{ text: "idle guess", probation: true }], "anything", 6)).toBeUndefined();
    expect(topAppliedStrategy([{ text: "corrected away", reward: -5 }], "anything", 6)).toBeUndefined();
  });
});
