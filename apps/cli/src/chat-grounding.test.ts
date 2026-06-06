import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_GROUNDING_MAX_HITS,
  CHAT_GROUNDING_MIN_SCORE,
  chatAbstention,
  chatAutoReindexEnabled,
  conversationMatches,
  formatChatGroundingBlock,
  gateChatAnswer,
  groundChatTurn,
  groundedNoteSources,
  isPersonalFactRecall,
  pickReindexModel,
  resolveGroundingMinScore,
  shortCitationRef,
  stripFabricatedCitations,
  stripTruncatedCitation,
  withGroundingReceipt
} from "./chat-grounding.js";
import type { RecallHit } from "./commands-recall.js";

describe("chat-path auto-reindex — the desktop reads a freshly-added note without a manual reindex", () => {
  it("is on by default and off only when explicitly disabled", () => {
    expect(chatAutoReindexEnabled({})).toBe(true);
    expect(chatAutoReindexEnabled({ MUSE_CHAT_AUTO_REINDEX: "1" })).toBe(true);
    expect(chatAutoReindexEnabled({ MUSE_CHAT_AUTO_REINDEX: "" })).toBe(true);
    expect(chatAutoReindexEnabled({ MUSE_CHAT_AUTO_REINDEX: "0" })).toBe(false);
  });

  it("preserves a stale index's own embedding model, falling back to the requested one", () => {
    expect(pickReindexModel("mxbai-embed-large", "nomic-embed-text")).toBe("mxbai-embed-large");
    expect(pickReindexModel(undefined, "nomic-embed-text")).toBe("nomic-embed-text");
    expect(pickReindexModel("", "nomic-embed-text")).toBe("nomic-embed-text");
    expect(pickReindexModel("   ", "nomic-embed-text")).toBe("nomic-embed-text");
  });
});

describe("resolveGroundingMinScore — the conformal-calibrated threshold is opt-in via env (A1c)", () => {
  it("defaults to CHAT_GROUNDING_MIN_SCORE (0.5) when the env is unset", () => {
    expect(resolveGroundingMinScore({})).toBe(CHAT_GROUNDING_MIN_SCORE);
  });

  it("honours a valid MUSE_GROUNDING_MIN_COSINE override (the calibrated value)", () => {
    expect(resolveGroundingMinScore({ MUSE_GROUNDING_MIN_COSINE: "0.559" })).toBeCloseTo(0.559, 6);
  });

  it("ignores an out-of-range / garbage value (never silently breaks the gate)", () => {
    for (const bad of ["0", "1.2", "-0.3", "nope", ""]) {
      expect(resolveGroundingMinScore({ MUSE_GROUNDING_MIN_COSINE: bad })).toBe(CHAT_GROUNDING_MIN_SCORE);
    }
  });

  it("the override flows into formatChatGroundingBlock: a 0.55 hit is injected at the default but held out at a 0.6 threshold", () => {
    const hits: RecallHit[] = [{ source: "notes", ref: "vpn.md", score: 0.55, snippet: "Office VPN MTU is 1380." }];
    expect(formatChatGroundingBlock(hits)).toContain("1380"); // default 0.5 → injected
    expect(formatChatGroundingBlock(hits, 0.6)).toBe(""); // a stricter calibrated cutoff holds it out
  });
});

describe("isPersonalFactRecall", () => {
  it("flags recall of the user's own stored facts", () => {
    expect(isPersonalFactRecall("내 강아지 이름 뭐야?")).toBe(true);
    expect(isPersonalFactRecall("내 고양이 이름이 뭐야")).toBe(true);
    expect(isPersonalFactRecall("내 와이파이 비밀번호 뭐였지?")).toBe(true);
    expect(isPersonalFactRecall("제 비밀번호 뭐였지?")).toBe(true); // 제 (humble my) + space
    expect(isPersonalFactRecall("what's my wifi password?")).toBe(true);
  });
  it("does NOT mistake 내일/제일 (tomorrow/most) for the possessive 내/제 — a planning question is NOT fact-recall", () => {
    expect(isPersonalFactRecall("이번 주 뭐가 제일 급해?")).toBe(false); // 제일 = most, not 제(my)
    expect(isPersonalFactRecall("오늘 제일 중요한 일이 뭐야?")).toBe(false);
    expect(isPersonalFactRecall("내일 뭐부터 해야 해?")).toBe(false); // 내일 = tomorrow, not 내(my)
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

describe("groundingReceipt (source quoted)", () => {
  it("cites only the note whose content is IN the answer (not every retrieved note)", () => {
    const matches = [
      { cosine: 0.7, score: 0.7, source: "/Users/x/.muse/notes/wifi/seoul_office.md", text: "와이파이 비밀번호는 muse2026 이야" },
      { cosine: 0.6, score: 0.6, source: "/Users/x/.muse/notes/dogfood-test.md", text: "Muse is a JARVIS-style agent" }, // retrieved but irrelevant
      { cosine: 0.3, score: 0.3, source: "/Users/x/.muse/notes/below.md", text: "muse2026 noise" } // below threshold
    ];
    // Answer states muse2026 → only seoul_office grounded it; dogfood (no shared
    // distinctive token) and the below-threshold note are excluded.
    expect(groundedNoteSources(matches, "비밀번호는 muse2026 입니다.")).toEqual(["seoul_office.md"]);
  });
  it("appends a 📎 receipt to a grounded answer (Korean)", () => {
    expect(withGroundingReceipt("비밀번호는 muse2026 입니다.", ["seoul_office.md"], true))
      .toBe("비밀번호는 muse2026 입니다.\n\n📎 노트: seoul_office.md");
  });
  it("does NOT receipt an abstention or a source-less answer", () => {
    expect(withGroundingReceipt(chatAbstention("내 생일?"), ["x.md"], true)).toBe(chatAbstention("내 생일?"));
    expect(withGroundingReceipt("일반 답변입니다.", [], true)).toBe("일반 답변입니다.");
  });

  it("A2 quorum hedge is opt-in (default off) and only fires on a SINGLE witness source", () => {
    // default off → no hedge, even with one source
    expect(withGroundingReceipt("월세는 125만원입니다.", ["lease.md"], true, {})).not.toContain("한 곳에만");
    // opt-in on + single witness → honest single-source hedge
    expect(withGroundingReceipt("월세는 125만원입니다.", ["lease.md"], true, { MUSE_QUORUM_HEDGE: "1" })).toContain("한 곳에만 근거한");
    expect(withGroundingReceipt("rent is 1.25M", ["lease.md"], false, { MUSE_QUORUM_HEDGE: "1" })).toContain("single note");
    // opt-in on + TWO corroborating witnesses → no hedge (corroborated)
    expect(withGroundingReceipt("월세는 125만원입니다.", ["lease.md", "budget.md"], true, { MUSE_QUORUM_HEDGE: "1" })).not.toContain("한 곳에만");
  });
});

function hit(over: Partial<RecallHit> = {}): RecallHit {
  return { source: "notes", ref: "vpn.md", score: 0.7, snippet: "Office VPN MTU is 1380.", ...over };
}

describe("stripTruncatedCitation (repair a mid-citation runtime truncation)", () => {
  it("drops an UNCLOSED trailing '[from …' fragment so the 📎 receipt can stand in", () => {
    expect(stripTruncatedCitation("비밀번호는 muse2026입니다. [from wifi_passwords/seoul_office."))
      .toBe("비밀번호는 muse2026입니다.");
  });
  it("leaves a COMPLETE inline citation untouched", () => {
    const complete = "비밀번호는 muse2026입니다. [from wifi_passwords/seoul_office.md]";
    expect(stripTruncatedCitation(complete)).toBe(complete);
  });
  it("leaves an answer with no citation untouched", () => {
    expect(stripTruncatedCitation("그건 아직 기억하고 있지 않아요.")).toBe("그건 아직 기억하고 있지 않아요.");
  });
});

describe("stripFabricatedCitations (drop a citation for a source that wasn't retrieved)", () => {
  const noteSrc = "/Users/x/.muse/notes/wifi_passwords/seoul_office.md";
  it("strips a fabricated non-existent source, keeping the answer text", () => {
    expect(stripFabricatedCitations("현재 비가 옵니다. [from weather]", [])).toBe("현재 비가 옵니다.");
    expect(stripFabricatedCitations("아마 맞을 거예요 [from internet]", [noteSrc])).toBe("아마 맞을 거예요");
  });
  it("keeps a citation that names a REAL retrieved source (short path or basename)", () => {
    expect(stripFabricatedCitations("비번은 muse2026 [from wifi_passwords/seoul_office.md]", [noteSrc]))
      .toBe("비번은 muse2026 [from wifi_passwords/seoul_office.md]");
    expect(stripFabricatedCitations("답 [from seoul_office.md]", [noteSrc])).toBe("답 [from seoul_office.md]");
  });
  it("keeps the real note citation but strips the fabricated one in a mixed answer", () => {
    expect(stripFabricatedCitations("비번 muse2026 [from seoul_office.md], 날씨 비 [from weather]", [noteSrc]))
      .toBe("비번 muse2026 [from seoul_office.md], 날씨 비");
  });
  it("leaves an answer with no citation untouched", () => {
    expect(stripFabricatedCitations("그냥 답변입니다.", [])).toBe("그냥 답변입니다.");
  });
});

describe("shortCitationRef", () => {
  it("strips the absolute notes-dir prefix so a citation is clean + leaks no home dir", () => {
    expect(shortCitationRef("/Users/jinan/.muse/notes/wifi_passwords/seoul_office.md")).toBe("wifi_passwords/seoul_office.md");
  });
  it("falls back to the basename for a path with no /notes/ segment", () => {
    expect(shortCitationRef("/var/data/report.md")).toBe("report.md");
  });
  it("passes a non-path ref through untouched", () => {
    expect(shortCitationRef("conversation")).toBe("conversation");
    expect(shortCitationRef("vpn.md")).toBe("vpn.md");
  });
});

describe("formatChatGroundingBlock", () => {
  it("emits an authoritative, citation-bearing block for a relevant hit", () => {
    const block = formatChatGroundingBlock([hit()]);
    expect(block).toContain("Office VPN MTU is 1380.");
    expect(block).toContain("[from vpn.md]");
    expect(block.toLowerCase()).toContain("authoritative");
  });

  it("cites a note by its notes-relative path, never the leaked absolute home path", () => {
    const block = formatChatGroundingBlock([hit({ ref: "/Users/jinan/.muse/notes/wifi_passwords/seoul_office.md" })]);
    expect(block).toContain("[from wifi_passwords/seoul_office.md]");
    expect(block).not.toContain("/Users/jinan");
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
  afterEach(() => vi.unstubAllEnvs());

  it("returns '' for a too-short turn without touching retrieval", async () => {
    expect(await groundChatTurn("hi")).toBe("");
  });

  it("returns '' when MUSE_CHAT_GROUNDING=0 (kill switch) without retrieval", async () => {
    expect(await groundChatTurn("what is my office VPN MTU?", { env: { MUSE_CHAT_GROUNDING: "0" } })).toBe("");
  });

  it("fails soft to '' when retrieval throws (no index / Ollama down)", async () => {
    // searchRecall reads the index path + Ollama URL from PROCESS env (not the
    // `env` it's handed), so stub the real ones: a nonexistent index + an
    // unreachable Ollama makes `embed` throw; retrieveChatGrounding swallows it.
    // (Passing only an `env` object left the real ~/.muse notes + live Ollama in
    // play, so this test passed only on a box with an empty notes corpus.)
    vi.stubEnv("MUSE_NOTES_INDEX_FILE", "/nonexistent/notes-index.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("MUSE_RECALL_TEST_QUERY_EMBEDDING", "");
    expect(await groundChatTurn("what is my office VPN MTU?")).toBe("");
  });
});
