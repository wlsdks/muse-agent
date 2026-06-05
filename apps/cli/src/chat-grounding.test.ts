import { describe, expect, it } from "vitest";

import {
  CHAT_GROUNDING_MAX_HITS,
  CHAT_GROUNDING_MIN_SCORE,
  chatAbstention,
  conversationMatches,
  formatChatGroundingBlock,
  gateChatAnswer,
  groundChatTurn,
  isPersonalFactRecall
} from "./chat-grounding.js";
import type { RecallHit } from "./commands-recall.js";

describe("isPersonalFactRecall", () => {
  it("flags recall of the user's own stored facts", () => {
    expect(isPersonalFactRecall("내 강아지 이름 뭐야?")).toBe(true);
    expect(isPersonalFactRecall("내 고양이 이름이 뭐야")).toBe(true);
    expect(isPersonalFactRecall("내 와이파이 비밀번호 뭐였지?")).toBe(true);
    expect(isPersonalFactRecall("what's my wifi password?")).toBe(true);
  });
  it("does NOT flag general or advice questions (never gate general knowledge)", () => {
    expect(isPersonalFactRecall("물 마시는 게 왜 중요해?")).toBe(false);
    expect(isPersonalFactRecall("내 아침 루틴 추천해줘")).toBe(false); // 추천=advice
    expect(isPersonalFactRecall("좋은 하루 보내는 방법 알려줘")).toBe(false);
    expect(isPersonalFactRecall("리액트에서 useState가 뭐야?")).toBe(false); // no possessive
  });
  it("does NOT flag a STATEMENT that provides a fact (the user telling us — never refuse)", () => {
    expect(isPersonalFactRecall("내 사무실 와이파이 비밀번호는 muse2026 이야. 기억해.")).toBe(false);
    expect(isPersonalFactRecall("내 강아지 이름은 보리야")).toBe(false);
  });
});

describe("gateChatAnswer (deterministic anti-fabrication gate)", () => {
  it("refuses an UNGROUNDED personal fact instead of letting it through", () => {
    const out = gateChatAnswer("내 고양이 이름이 뭐야?", "당신의 고양이 이름은 미니입니다.", []);
    expect(out).toBe(chatAbstention("내 고양이 이름이 뭐야?"));
    expect(out).toContain("기억");
  });
  it("keeps an answer grounded in the conversation", () => {
    const evidence = conversationMatches([
      { role: "user", content: "내 사무실 와이파이 비밀번호는 muse2026 이야." },
      { role: "assistant", content: "기억해뒀어요." }
    ]);
    const out = gateChatAnswer("내 와이파이 비밀번호 뭐였지?", "와이파이 비밀번호는 muse2026 입니다.", evidence);
    expect(out).toContain("muse2026");
  });
  it("passes general / non-recall turns through untouched", () => {
    const general = "물은 신체 기능 유지에 필수입니다.";
    expect(gateChatAnswer("물 마시는 게 왜 중요해?", general, [])).toBe(general);
  });
  it("passes the USER's own name cross-language (user_name stored, asked in Korean)", () => {
    // "진안" shares no token with the English-keyed user_name, so only the
    // topic→key match rescues it from a false refusal.
    const out = gateChatAnswer("내 이름이 뭐야?", "당신의 이름은 진안입니다.", [], ["user_name"]);
    expect(out).toBe("당신의 이름은 진안입니다.");
  });
  it("passes an entity fact Muse HAS (dog_name stored → 강아지 question)", () => {
    const out = gateChatAnswer("내 강아지 이름이 뭐야?", "강아지 이름은 보리입니다.", [], ["user_name", "dog_name"]);
    expect(out).toBe("강아지 이름은 보리입니다.");
  });
  it("REFUSES a cross-entity conflation — cat NOT stored, must not answer the dog's name", () => {
    const out = gateChatAnswer("내 고양이 이름이 뭐야?", "고양이 이름은 보리입니다.", [], ["user_name", "dog_name"]);
    expect(out).toBe(chatAbstention("내 고양이 이름이 뭐야?"));
  });
  it("still refuses a recall whose topic is NOT on file (birthday never stored)", () => {
    const out = gateChatAnswer("내 생일 언제야?", "당신의 생일은 5월 3일입니다.", [], ["user_name"]);
    expect(out).toBe(chatAbstention("내 생일 언제야?"));
  });
});

function hit(over: Partial<RecallHit> = {}): RecallHit {
  return { source: "notes", ref: "vpn.md", score: 0.7, snippet: "Office VPN MTU is 1380.", ...over };
}

describe("formatChatGroundingBlock", () => {
  it("emits an authoritative, citation-bearing block for a relevant hit", () => {
    const block = formatChatGroundingBlock([hit()]);
    expect(block).toContain("Office VPN MTU is 1380.");
    expect(block).toContain("[from vpn.md]");
    expect(block.toLowerCase()).toContain("authoritative");
  });

  it("returns '' when every hit is below the relevance threshold (refusal floor intact)", () => {
    expect(formatChatGroundingBlock([hit({ score: CHAT_GROUNDING_MIN_SCORE - 0.01 })])).toBe("");
  });

  it("returns '' for no hits", () => {
    expect(formatChatGroundingBlock([])).toBe("");
  });

  it("keeps a hit exactly at the threshold", () => {
    expect(formatChatGroundingBlock([hit({ score: CHAT_GROUNDING_MIN_SCORE })])).not.toBe("");
  });

  it("caps the injected passages at CHAT_GROUNDING_MAX_HITS", () => {
    const many = Array.from({ length: CHAT_GROUNDING_MAX_HITS + 3 }, (_unused, i) =>
      hit({ ref: `n${i}.md`, snippet: `fact ${i}`, score: 0.9 })
    );
    const block = formatChatGroundingBlock(many);
    const bullets = block.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toHaveLength(CHAT_GROUNDING_MAX_HITS);
  });

  it("respects a custom minScore", () => {
    expect(formatChatGroundingBlock([hit({ score: 0.4 })], 0.3)).not.toBe("");
    expect(formatChatGroundingBlock([hit({ score: 0.4 })], 0.5)).toBe("");
  });
});

describe("groundChatTurn", () => {
  it("returns '' for a too-short turn without touching retrieval", async () => {
    expect(await groundChatTurn("hi")).toBe("");
  });

  it("returns '' when MUSE_CHAT_GROUNDING=0 (kill switch) without retrieval", async () => {
    expect(await groundChatTurn("what is my office VPN MTU?", { env: { MUSE_CHAT_GROUNDING: "0" } })).toBe("");
  });

  it("fails soft to '' when retrieval throws (no index / Ollama down)", async () => {
    // No notes index + no test-embedding hook => searchRecall throws on embed; we swallow it.
    const block = await groundChatTurn("what is my office VPN MTU?", {
      env: { MUSE_NOTES_INDEX_FILE: "/nonexistent/notes-index.json", OLLAMA_BASE_URL: "http://127.0.0.1:1" }
    });
    expect(block).toBe("");
  });
});
