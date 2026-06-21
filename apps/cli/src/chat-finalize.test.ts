import { describe, expect, it } from "vitest";

import type { KnowledgeMatch } from "@muse/agent-core";

import { finalizeGatedChatAnswer, isChatAbstention } from "./chat-grounding.js";

const matches: readonly KnowledgeMatch[] = [
  { cosine: 0.9, score: 0.9, source: "wifi.md", text: "사무실 와이파이 비밀번호는 muse2026 입니다" }
];

describe("finalizeGatedChatAnswer (the ONE post-stream pipeline for every chat surface)", () => {
  it("refuses an ungrounded personal-fact answer (the ink-chat hole)", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "내 고양이 이름은 나비예요",
      matches: [],
      question: "내 고양이 이름이 뭐야?"
    });
    expect(isChatAbstention(out)).toBe(true);
  });

  it("strips a fabricated citation but keeps a real-source answer + appends the receipt", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "비밀번호는 muse2026 입니다 [from weather]",
      matches,
      question: "사무실 와이파이 비밀번호 뭐야?"
    });
    expect(out).not.toContain("[from weather]");
    expect(out).toContain("muse2026");
    expect(out).toContain("wifi.md");
  });

  it("a real tool result IS the grounding — a faithful tool-grounded answer surfaces", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "할 일은 보고서 작성 1건이에요",
      matches: [],
      question: "내 할일 뭐 있어?",
      toolsUsed: ["muse.tasks.list"],
      toolGroundingSources: [{ source: "muse.tasks.list", text: "할 일: 보고서 작성" }]
    });
    expect(out).toContain("보고서");
  });

  it("a tool-grounded answer asserting a value the tool did NOT return is still abstained (value check survives tool grounding)", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "당신의 월세는 1,500,000 KRW입니다",
      matches: [],
      question: "내 월세 얼마야?",
      toolsUsed: ["knowledge_search"],
      toolGroundingSources: [{ source: "knowledge_search", text: "월세는 1,250,000 KRW, 매월 1일 납부" }]
    });
    expect(isChatAbstention(out)).toBe(true);
  });

  it("a tool RAN but returned no grounding → the gate is NOT bypassed (closes the empty-result hole)", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "당신의 월세는 1,500,000 KRW입니다",
      matches: [],
      question: "내 월세 얼마야?",
      toolsUsed: ["calendar_add"],
      toolGroundingSources: []
    });
    expect(isChatAbstention(out)).toBe(true);
  });

  it("a fact stated earlier in THIS conversation counts as evidence", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "your blood type is B positive",
      history: [{ content: "remember this: my blood type is B positive", role: "user" }],
      matches: [],
      question: "what is my blood type?"
    });
    expect(isChatAbstention(out)).toBe(false);
  });
});

describe("finalizeGatedChatAnswer — semantic prose value-conflict surfacing (GROUNDED≠TRUE parity with ask, arXiv:2504.19413)", () => {
  // Two TRUSTED user notes that disagree on the same fact in FREE PROSE (no
  // `label: value` syntax) — the labelled conflict detector misses these, so
  // before this fix the chat surface emitted a clean grounded receipt and the
  // user never learned the notes contradict. Injected embed → no live Ollama.
  const sameVector = async (): Promise<readonly number[]> => [1, 0, 0]; // identical → cosine 1.0 ≥ topic gate
  const conflicting: readonly KnowledgeMatch[] = [
    { cosine: 0.9, score: 0.9, source: "flight.md", text: "Your flight to Tokyo departs at 3pm on Friday." },
    { cosine: 0.9, score: 0.9, source: "trip-notes.md", text: "Your flight to Tokyo departs at 6pm on Friday." }
  ];

  it("surfaces a cue naming BOTH sources when two notes disagree in prose", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "Your flight to Tokyo departs at 3pm on Friday. [from flight.md]",
      matches: conflicting,
      question: "What time does my flight to Tokyo leave?",
      embed: sameVector
    });
    expect(out).toContain("flight.md");
    expect(out).toContain("trip-notes.md");
    expect(out.toLowerCase()).toContain("disagree");
  });

  it("does NOT over-fire when the two notes AGREE (subset, not a conflict)", async () => {
    const agreeing: readonly KnowledgeMatch[] = [
      { cosine: 0.9, score: 0.9, source: "flight.md", text: "Your flight to Tokyo departs at 3pm." },
      { cosine: 0.9, score: 0.9, source: "trip-notes.md", text: "Your flight to Tokyo departs at 3pm on Friday." }
    ];
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "Your flight to Tokyo departs at 3pm. [from flight.md]",
      matches: agreeing,
      question: "What time does my flight to Tokyo leave?",
      embed: sameVector
    });
    expect(out.toLowerCase()).not.toContain("disagree");
  });

  it("fail-open: no embed supplied → no semantic cue, answer still surfaces (today's behaviour)", async () => {
    const { display: out } = await finalizeGatedChatAnswer({
      answer: "Your flight to Tokyo departs at 3pm on Friday. [from flight.md]",
      matches: conflicting,
      question: "What time does my flight to Tokyo leave?"
    });
    expect(out.toLowerCase()).not.toContain("disagree");
    expect(out).toContain("3pm");
  });
});

describe("finalizeGatedChatAnswer — forHistory excludes display-only source-check cues (grounded≠true: a cue must not be replayed as trusted evidence)", () => {
  // A faithful answer resting ONLY on a tool source gets the untrusted-only cue on
  // DISPLAY. If that cue text were persisted to history/episodes/auto-memory, the next
  // turn's conversationMatches would replay it as cosine-1 TRUSTED grounding evidence —
  // an untrusted-source WARNING laundered into trusted evidence. `forHistory` drops it.
  it("display carries the source-check cue, forHistory does NOT (but keeps the answer)", async () => {
    const result = await finalizeGatedChatAnswer({
      answer: "할 일은 보고서 작성 1건이에요",
      matches: [],
      question: "내 할일 뭐 있어?",
      toolsUsed: ["muse.tasks.list"],
      toolGroundingSources: [{ source: "muse.tasks.list", text: "할 일: 보고서 작성" }]
    });
    expect(result.display).toContain("출처 확인"); // the untrusted-only cue is shown
    expect(result.forHistory).not.toContain("출처 확인"); // ...but NOT persisted as evidence
    expect(result.forHistory).toContain("보고서"); // the actual answer content survives
  });

  it("a clean grounded+cited answer has display === forHistory (no cue to strip, no drift)", async () => {
    const result = await finalizeGatedChatAnswer({
      answer: "비밀번호는 muse2026 입니다 [from wifi.md]",
      matches,
      question: "사무실 와이파이 비밀번호 뭐야?"
    });
    expect(result.forHistory).toBe(result.display); // trusted + cited → no cue appended
  });
});
