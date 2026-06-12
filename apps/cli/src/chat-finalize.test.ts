import { describe, expect, it } from "vitest";

import type { KnowledgeMatch } from "@muse/agent-core";

import { finalizeGatedChatAnswer, isChatAbstention } from "./chat-grounding.js";

const matches: readonly KnowledgeMatch[] = [
  { cosine: 0.9, score: 0.9, source: "wifi.md", text: "사무실 와이파이 비밀번호는 muse2026 입니다" }
];

describe("finalizeGatedChatAnswer (the ONE post-stream pipeline for every chat surface)", () => {
  it("refuses an ungrounded personal-fact answer (the ink-chat hole)", async () => {
    const out = await finalizeGatedChatAnswer({
      answer: "내 고양이 이름은 나비예요",
      matches: [],
      question: "내 고양이 이름이 뭐야?"
    });
    expect(isChatAbstention(out)).toBe(true);
  });

  it("strips a fabricated citation but keeps a real-source answer + appends the receipt", async () => {
    const out = await finalizeGatedChatAnswer({
      answer: "비밀번호는 muse2026 입니다 [from weather]",
      matches,
      question: "사무실 와이파이 비밀번호 뭐야?"
    });
    expect(out).not.toContain("[from weather]");
    expect(out).toContain("muse2026");
    expect(out).toContain("wifi.md");
  });

  it("a real tool result IS the grounding — a faithful tool-grounded answer surfaces", async () => {
    const out = await finalizeGatedChatAnswer({
      answer: "할 일은 보고서 작성 1건이에요",
      matches: [],
      question: "내 할일 뭐 있어?",
      toolsUsed: ["muse.tasks.list"],
      toolGroundingSources: [{ source: "muse.tasks.list", text: "할 일: 보고서 작성" }]
    });
    expect(out).toContain("보고서");
  });

  it("a tool-grounded answer asserting a value the tool did NOT return is still abstained (value check survives tool grounding)", async () => {
    const out = await finalizeGatedChatAnswer({
      answer: "당신의 월세는 1,500,000 KRW입니다",
      matches: [],
      question: "내 월세 얼마야?",
      toolsUsed: ["knowledge_search"],
      toolGroundingSources: [{ source: "knowledge_search", text: "월세는 1,250,000 KRW, 매월 1일 납부" }]
    });
    expect(isChatAbstention(out)).toBe(true);
  });

  it("a tool RAN but returned no grounding → the gate is NOT bypassed (closes the empty-result hole)", async () => {
    const out = await finalizeGatedChatAnswer({
      answer: "당신의 월세는 1,500,000 KRW입니다",
      matches: [],
      question: "내 월세 얼마야?",
      toolsUsed: ["calendar_add"],
      toolGroundingSources: []
    });
    expect(isChatAbstention(out)).toBe(true);
  });

  it("a fact stated earlier in THIS conversation counts as evidence", async () => {
    const out = await finalizeGatedChatAnswer({
      answer: "your blood type is B positive",
      history: [{ content: "remember this: my blood type is B positive", role: "user" }],
      matches: [],
      question: "what is my blood type?"
    });
    expect(isChatAbstention(out)).toBe(false);
  });
});
