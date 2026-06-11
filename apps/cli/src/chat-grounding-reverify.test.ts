import { describe, expect, it } from "vitest";

import type { KnowledgeMatch } from "@muse/agent-core";

import { gateChatAnswerWithReverify, isChatAbstention } from "./chat-grounding.js";

const QUESTION = "내 사무실 와이파이 비번 뭐야?";
const weakMatches: readonly KnowledgeMatch[] = [
  { cosine: 0.55, score: 0.55, source: "wifi.md", text: "office wifi password changed recently in june" }
];
// No ≥5-char token shared with the note (the quote shortcut must not fire),
// no number, no email — the verdict path decides, and it lands in the band
// the reverify judge escalates.
const BORDERLINE_ANSWER = "It is on the desk memo";

const countingReverify = (result: boolean): { calls: () => number; reverify: () => Promise<boolean> } => {
  let calls = 0;
  return {
    calls: () => calls,
    reverify: () => {
      calls += 1;
      return Promise.resolve(result);
    }
  };
};

describe("gateChatAnswerWithReverify (chat parity with ask's judge-backed escalation)", () => {
  it("rescues a borderline answer the sync gate would refuse when the judge upholds it", async () => {
    const judge = countingReverify(true);
    const gated = await gateChatAnswerWithReverify(QUESTION, BORDERLINE_ANSWER, weakMatches, [], judge.reverify);
    expect(gated).toBe(BORDERLINE_ANSWER);
    expect(judge.calls()).toBe(1);
  });

  it("abstains when the judge rejects the borderline answer", async () => {
    const judge = countingReverify(false);
    const gated = await gateChatAnswerWithReverify(QUESTION, BORDERLINE_ANSWER, weakMatches, [], judge.reverify);
    expect(isChatAbstention(gated)).toBe(true);
  });

  it("fail-close: a judge error never lets the borderline answer through", async () => {
    const gated = await gateChatAnswerWithReverify(QUESTION, BORDERLINE_ANSWER, weakMatches, [], () => Promise.reject(new Error("ollama down")));
    expect(isChatAbstention(gated)).toBe(true);
  });

  it("a fabricated NUMBER is refused deterministically — the judge is never consulted", async () => {
    const judge = countingReverify(true);
    const gated = await gateChatAnswerWithReverify(QUESTION, "비번은 9999 입니다", weakMatches, [], judge.reverify);
    expect(isChatAbstention(gated)).toBe(true);
    expect(judge.calls()).toBe(0);
  });

  it("a clearly note-grounded answer passes with zero extra inference", async () => {
    const judge = countingReverify(false);
    const matches: readonly KnowledgeMatch[] = [
      { cosine: 1, score: 1, source: "color.md", text: "좋아하는 색깔은 청록색입니다" }
    ];
    const gated = await gateChatAnswerWithReverify("내 좋아하는 색깔 뭐야?", "청록색입니다", matches, [], judge.reverify);
    expect(gated).toBe("청록색입니다");
    expect(judge.calls()).toBe(0);
  });

  it("a non-personal question passes through untouched with zero calls", async () => {
    const judge = countingReverify(false);
    const gated = await gateChatAnswerWithReverify("오늘 날씨 어때?", BORDERLINE_ANSWER, weakMatches, [], judge.reverify);
    expect(gated).toBe(BORDERLINE_ANSWER);
    expect(judge.calls()).toBe(0);
  });
});
