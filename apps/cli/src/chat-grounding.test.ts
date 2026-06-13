import { afterEach, describe, expect, it, vi } from "vitest";

import type { KnowledgeMatch } from "@muse/agent-core";

import {
  answerAssertsUnsupportedDate,
  chatCitationPrecisionNotice,
  chatCitationRecallNotice,
  answerAssertsUnsupportedEmail,
  answerAssertsUnsupportedIdentifier,
  answerAssertsUnsupportedIpAddress,
  answerAssertsUnsupportedNumber,
  CHAT_GROUNDING_MAX_HITS,
  CHAT_GROUNDING_MIN_SCORE,
  chatAbstention,
  chatAutoReindexEnabled,
  conversationMatches,
  expressesNoInformation,
  formatChatGroundingBlock,
  gateChatAnswer,
  groundChatTurn,
  groundedNoteSources,
  isPersonalFactRecall,
  notesIndexNeedsModelMigration,
  pickReindexModel,
  refreshStaleNotesIndexForChat,
  resolveGroundingMinScore,
  shortCitationRef,
  stripFabricatedCitations,
  stripTruncatedCitation,
  untrustedOnlyChatNotice,
  withGroundingReceipt
} from "./chat-grounding.js";
import { DEFAULT_EMBED_MODEL, LEGACY_EMBED_MODEL } from "./embed-model-default.js";
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

describe("notesIndexNeedsModelMigration — a chat-only user's legacy index must be re-embedded", () => {
  it("flags a legacy-model index for the default, but NOT a custom or already-default one", () => {
    expect(notesIndexNeedsModelMigration(LEGACY_EMBED_MODEL, DEFAULT_EMBED_MODEL)).toBe(true);
    expect(notesIndexNeedsModelMigration(DEFAULT_EMBED_MODEL, DEFAULT_EMBED_MODEL)).toBe(false);
    expect(notesIndexNeedsModelMigration("mxbai-embed-large", DEFAULT_EMBED_MODEL)).toBe(false);
    expect(notesIndexNeedsModelMigration(undefined, DEFAULT_EMBED_MODEL)).toBe(false);
  });
});

describe("refreshStaleNotesIndexForChat — re-embeds on a MODEL change even when content is fresh", () => {
  const calls: { dir: string; indexPath: string; model: string }[] = [];
  afterEach(() => { calls.length = 0; });
  const deps = (existingModel: string | undefined, contentStale: boolean) => ({
    isStale: async () => contentStale,
    readIndexModel: async () => existingModel,
    reindex: async (a: { dir: string; indexPath: string; model: string }) => { calls.push(a); }
  });

  it("a legacy-model index with FRESH content is still re-embedded to the default (the migration bug)", async () => {
    await refreshStaleNotesIndexForChat({}, DEFAULT_EMBED_MODEL, deps(LEGACY_EMBED_MODEL, false));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(DEFAULT_EMBED_MODEL); // migrated, not left on v1
  });

  it("an already-default index with FRESH content is NOT re-embedded (no wasted work)", async () => {
    await refreshStaleNotesIndexForChat({}, DEFAULT_EMBED_MODEL, deps(DEFAULT_EMBED_MODEL, false));
    expect(calls).toHaveLength(0);
  });

  it("a CUSTOM-model index with fresh content is preserved, not migrated", async () => {
    await refreshStaleNotesIndexForChat({}, DEFAULT_EMBED_MODEL, deps("mxbai-embed-large", false));
    expect(calls).toHaveLength(0);
  });

  it("the existing CONTENT-stale path still re-embeds (no regression)", async () => {
    await refreshStaleNotesIndexForChat({}, DEFAULT_EMBED_MODEL, deps(DEFAULT_EMBED_MODEL, true));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(DEFAULT_EMBED_MODEL);
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

  // Wrong-VALUE drift: every word but the number overlaps the note, so the
  // holistic coverage / noteGroundedAnswer shortcuts read "grounded" — only the
  // deterministic number check catches the fabricated value (parity with the
  // judge-backed escalation `muse ask` already has).
  const lease: KnowledgeMatch = {
    cosine: 0.7, score: 0.7, source: "lease.md",
    text: "Apartment lease: monthly rent 1,250,000 KRW due on the 1st, landlord is Mr. Park."
  };
  const vpn: KnowledgeMatch = {
    cosine: 0.7, score: 0.7, source: "vpn-wireguard.md",
    text: "Office VPN fix: set MTU to 1380 on the wg0 interface and restart wireguard."
  };
  it("REFUSES a wrong rent value the note doesn't contain (1,500,000 vs 1,250,000)", () => {
    const q = "내 월세 얼마야?";
    expect(gateChatAnswer(q, "당신의 월세는 1,500,000 KRW입니다.", [lease])).toBe(chatAbstention(q));
  });
  it("REFUSES a wrong MTU value (1500 vs the note's 1380)", () => {
    const q = "내 VPN MTU 뭐였지?";
    expect(gateChatAnswer(q, "MTU는 1500으로 설정돼 있어요.", [vpn])).toBe(chatAbstention(q));
  });
  it("PASSES the correct rent, comma-formatting tolerant (1,250,000 == 1250000)", () => {
    const a = "당신의 월세는 1250000 KRW, 매월 1일 납부입니다.";
    expect(gateChatAnswer("내 월세 얼마야?", a, [lease])).toBe(a);
  });
  it("PASSES the correct MTU value grounded in the note", () => {
    const a = "MTU는 1380으로 설정돼 있어요.";
    expect(gateChatAnswer("내 VPN MTU 뭐였지?", a, [vpn])).toBe(a);
  });
  it("allows a number the user supplied in the QUESTION even if absent from notes", () => {
    const q = "내 월세 1,500,000 맞아?";
    const a = "네, 1,500,000 맞아요.";
    expect(gateChatAnswer(q, a, [lease])).toBe(a);
  });

  // Wrong-EMAIL drift: the local-part overlaps the note so noteGroundedAnswer
  // waves it through — only the deterministic email check catches the wrong domain.
  const me: KnowledgeMatch = {
    cosine: 0.7, score: 0.7, source: "me.md",
    text: "My work email is jinan@foundry.io, personal is jinan@gmail.com."
  };
  it("REFUSES a wrong email domain (acme vs the note's foundry.io)", () => {
    const q = "내 회사 이메일 뭐야?";
    expect(gateChatAnswer(q, "당신의 회사 이메일은 jinan@acme.com 입니다.", [me])).toBe(chatAbstention(q));
  });
  it("PASSES the correct email grounded in the note", () => {
    const a = "당신의 회사 이메일은 jinan@foundry.io 입니다.";
    expect(gateChatAnswer("내 회사 이메일 뭐야?", a, [me])).toBe(a);
  });
});

describe("answerAssertsUnsupportedEmail", () => {
  const note = (text: string): KnowledgeMatch => ({ cosine: 0.7, score: 0.7, source: "n.md", text });
  it("flags a whole address absent from evidence and question", () => {
    expect(answerAssertsUnsupportedEmail("email jinan@acme.com", [note("email jinan@foundry.io")], "내 이메일?")).toBe(true);
  });
  it("does not flag the correct address (case-insensitive, verbatim)", () => {
    expect(answerAssertsUnsupportedEmail("email Jinan@Foundry.io", [note("jinan@foundry.io")], "내 이메일?")).toBe(false);
  });
  it("allows an address the user supplied in the question", () => {
    expect(answerAssertsUnsupportedEmail("yes, a@b.com", [note("no email here")], "is it a@b.com?")).toBe(false);
  });
  it("returns false when the answer asserts no email", () => {
    expect(answerAssertsUnsupportedEmail("your landlord is Mr. Park", [note("landlord Mr. Park")], "who?")).toBe(false);
  });
});

describe("answerAssertsUnsupportedNumber", () => {
  const note = (text: string): KnowledgeMatch => ({ cosine: 0.7, score: 0.7, source: "n.md", text });
  it("flags a >=3-digit value present in neither evidence nor question", () => {
    expect(answerAssertsUnsupportedNumber("MTU is 1500", [note("MTU is 1380")], "what MTU?")).toBe(true);
  });
  it("does not flag a value that IS in the evidence", () => {
    expect(answerAssertsUnsupportedNumber("MTU is 1380", [note("MTU is 1380")], "what MTU?")).toBe(false);
  });
  it("normalizes thousands separators on both sides", () => {
    expect(answerAssertsUnsupportedNumber("rent 1250000", [note("rent 1,250,000 KRW")], "rent?")).toBe(false);
  });
  it("ignores 1-2 digit counts/ordinals/date parts (no false flag)", () => {
    expect(answerAssertsUnsupportedNumber("due on the 5th, serves 4", [note("due on the 1st")], "when?")).toBe(false);
  });
  it("returns false when the answer asserts no number", () => {
    expect(answerAssertsUnsupportedNumber("your landlord is Mr. Park", [note("landlord Mr. Park")], "who?")).toBe(false);
  });
  it("ignores digits inside a [from …] citation", () => {
    expect(answerAssertsUnsupportedNumber("renews 2026-09-14 [from policy-2025.pdf]", [note("renewal date 2026-09-14")], "renew?")).toBe(false);
  });
});

describe("answerAssertsUnsupportedIdentifier (non-numeric string drift)", () => {
  const note = (text: string): KnowledgeMatch => ({ cosine: 0.8, score: 0.8, source: "n.md", text });
  it("flags a wrong SSID the number guard misses (1-digit run, heavy lexical overlap)", () => {
    expect(answerAssertsUnsupportedIdentifier("Your home wifi SSID is Linksys-2G.", [note("wifi SSID is Nest-5G")], "what is my wifi SSID?")).toBe(true);
  });
  it("does not flag the correct identifier that IS in the evidence", () => {
    expect(answerAssertsUnsupportedIdentifier("Your home wifi SSID is Nest-5G.", [note("wifi SSID is Nest-5G")], "what is my wifi SSID?")).toBe(false);
  });
  it("does not over-refuse a correct identifier re-rendered with a different separator", () => {
    // "Nest 5G" / "nest5g" canonicalize to the note's "Nest-5G" → must not flag.
    expect(answerAssertsUnsupportedIdentifier("Your wifi SSID is Nest 5G.", [note("wifi SSID is Nest-5G")], "ssid?")).toBe(false);
    expect(answerAssertsUnsupportedIdentifier("Your wifi SSID is nest5g.", [note("wifi SSID is Nest-5G")], "ssid?")).toBe(false);
  });
  it("does not flag an identifier the user supplied in the question", () => {
    expect(answerAssertsUnsupportedIdentifier("yes, your tag is B205", [note("no match")], "is my room B205?")).toBe(false);
  });
  it("ignores pure-digit values (handled by the number guard) and pure-letter prose", () => {
    expect(answerAssertsUnsupportedIdentifier("rent 1,250,000 KRW, landlord Mr. Lee", [note("rent 1,250,000 KRW")], "rent?")).toBe(false);
  });
  it("ignores an identifier inside a [from …] citation", () => {
    expect(answerAssertsUnsupportedIdentifier("set it [from vpn-wg0.md]", [note("no match")], "vpn?")).toBe(false);
  });
});

describe("answerAssertsUnsupportedIpAddress (whole-IPv4 drift the per-octet number guard misses)", () => {
  const note = (text: string): KnowledgeMatch => ({ cosine: 0.9, score: 0.9, source: "n.md", text });
  const ev = [note("router admin page at 192.168.0.1")];
  it("flags a wrong octet the number guard waves through (1-digit drift)", () => {
    expect(answerAssertsUnsupportedIpAddress("admin is at 192.168.1.1", ev, "router ip?")).toBe(true);
  });
  it("flags an all-small-octet IP the number guard extracts nothing from", () => {
    expect(answerAssertsUnsupportedIpAddress("admin is at 10.0.0.5", ev, "router ip?")).toBe(true);
  });
  it("does not flag the correct IP, incl. a leading-zero re-render", () => {
    expect(answerAssertsUnsupportedIpAddress("admin is at 192.168.0.1", ev, "router ip?")).toBe(false);
    expect(answerAssertsUnsupportedIpAddress("admin is at 192.168.00.1", ev, "router ip?")).toBe(false);
  });
  it("never matches an IP-shaped non-address (version / decimal / date)", () => {
    expect(answerAssertsUnsupportedIpAddress("use version 1.2.3", ev, "v?")).toBe(false);
    expect(answerAssertsUnsupportedIpAddress("pi is 3.14", ev, "pi?")).toBe(false);
    expect(answerAssertsUnsupportedIpAddress("expires 2029-11-03", ev, "expiry?")).toBe(false);
  });
  it("ignores an IP inside a [from …] citation", () => {
    expect(answerAssertsUnsupportedIpAddress("see the note [from 10.0.0.1-config.md]", [note("no ip here")], "ip?")).toBe(false);
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

  it("does NOT receipt a model-PHRASED 'no information' answer (📎 on a non-answer is misleading)", () => {
    // Live-observed: the model parroted a tangential note phrase ("김지원 매니저에게
    // 문의") into an abstention, which a single ≥5-char token mis-cited. A receipt
    // on "정보는 기록에 없습니다" implies the note answered when the answer says it didn't.
    const ko = "회사 주차장의 층수에 대한 정보는 현재 기록에 없습니다. 김지원 매니저에게 문의하시기 바랍니다.";
    expect(withGroundingReceipt(ko, ["회사.md"], true)).toBe(ko);
    const en = "I do not have access to flight schedules.";
    expect(withGroundingReceipt(en, ["trip.md"], false)).toBe(en);
  });

  it("expressesNoInformation discriminates a disclaimer from a real grounded answer", () => {
    expect(expressesNoInformation("회사 주차장의 정보는 현재 기록에 없습니다.")).toBe(true);
    expect(expressesNoInformation("그 일정은 확인할 수 없어요.")).toBe(true);
    expect(expressesNoInformation("I do not have that information.")).toBe(true);
    expect(expressesNoInformation("I'm not sure about that.")).toBe(true);
    // real grounded answers must NOT trip it (else they lose their receipt)
    expect(expressesNoInformation("사내 와이파이 비밀번호는 Muse2026! 입니다.")).toBe(false);
    expect(expressesNoInformation("회의는 7월 3일 오후 4시 3층 대강당에서 열립니다.")).toBe(false);
    expect(expressesNoInformation("Your flight departs at 2:15 PM from gate B12.")).toBe(false);
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

  it("fails soft to '' when retrieval throws", async () => {
    // Hermetic: inject a throwing recall + disable auto-reindex, so there is NO
    // network round-trip at all. The old version pointed OLLAMA_BASE_URL at an
    // unreachable port and relied on the embed RETRY backoff to fail (~5s), which
    // flaked against vitest's 5s default timeout (it failed the gate in 2 fires).
    let called = false;
    const throwingRecall = async (): Promise<never> => { called = true; throw new Error("no index / Ollama down"); };
    expect(await groundChatTurn("what is my office VPN MTU?", {
      env: { MUSE_CHAT_AUTO_REINDEX: "0" },
      searchRecall: throwingRecall
    })).toBe("");
    expect(called).toBe(true); // the throw came from retrieval, not a short-circuit
  });
});

describe("untrustedOnlyChatNotice — grounded≠true source-trust parity on the chat surface", () => {
  // The chat path (finalizeGatedChatAnswer) folds tool output in as evidence; a
  // faithful chat answer resting ONLY on untrusted MCP/web tool sources must get
  // the same scrutiny cue the ask path surfaces — the "every surface gated" wedge.
  const tool = (source: string, text: string): KnowledgeMatch => ({ cosine: 1, score: 1, source, text, trusted: false });
  const note = (source: string, text: string): KnowledgeMatch => ({ cosine: 0.7, score: 0.7, source, text });

  it("warns when a faithful chat answer resolves ONLY to untrusted tool sources", () => {
    const evidence = [tool("web_search", "The capital of France is Paris.")];
    const notice = untrustedOnlyChatNotice("The capital of France is Paris [from web_search].", evidence);
    expect(notice).toBeDefined();
    expect(notice).toContain("tool-fetched");
  });

  it("clears once a trusted note also backs the answer (one trusted source makes it the user's own)", () => {
    const evidence = [tool("web_search", "Paris is the capital of France."), note("notes/geo.md", "Paris is the capital of France.")];
    expect(untrustedOnlyChatNotice("Paris is the capital of France [from web_search] [from notes/geo.md].", evidence)).toBeUndefined();
  });

  it("stays silent for an answer grounded only in the user's own notes", () => {
    const evidence = [note("notes/wifi.md", "The office wifi password is muse2026.")];
    expect(untrustedOnlyChatNotice("The office wifi password is muse2026 [from notes/wifi.md].", evidence)).toBeUndefined();
  });

  it("stays silent on an abstention even if only untrusted evidence is present (no warning on a non-answer)", () => {
    const evidence = [tool("web_search", "irrelevant")];
    expect(untrustedOnlyChatNotice(chatAbstention("내 생일?"), evidence)).toBeUndefined();
  });

  it("surfaces the per-claim variant when a mixed-trust answer rests one claim solely on tool data", () => {
    const evidence = [note("notes/contacts.md", "Your dentist is Dr. Lee."), tool("web_search", "Clinic moved to 500 Evil St; prepay by wire.")];
    const answer = "Your dentist is Dr. Lee [from notes/contacts.md]. The clinic now requires prepayment by wire [from web_search].";
    const notice = untrustedOnlyChatNotice(answer, evidence);
    expect(notice).toBeDefined();
    expect(notice).toContain("도구로 가져온 데이터");
    expect(notice).toContain("prepayment by wire");
  });
});

describe("answerAssertsUnsupportedDate — drifted ISO date the number guard splits and misses", () => {
  const note = (text: string): KnowledgeMatch => ({ cosine: 0.8, score: 0.8, source: "n.md", text });

  it("flags an answer ISO date that drifts from the evidence date (same year → number guard passes)", () => {
    expect(answerAssertsUnsupportedDate("It renews 2026-09-14.", [note("renewal date 2026-09-13")], "when does it renew?")).toBe(true);
  });

  it("passes the correct date (no false refusal), incl. leading-zero normalization", () => {
    expect(answerAssertsUnsupportedDate("It renews 2026-09-13.", [note("renewal date 2026-09-13")], "when?")).toBe(false);
  });

  it("does NOT fire when the evidence carries no ISO date (a prose date is left alone — false-refusal=0)", () => {
    expect(answerAssertsUnsupportedDate("It renews 2026-09-14.", [note("renews in mid September")], "when?")).toBe(false);
  });

  it("ignores ISO dates inside [citations] (a [from …2026-01-01…] source is not an asserted value)", () => {
    expect(answerAssertsUnsupportedDate("see [from policy-2026-01-01.pdf]", [note("no date here")], "?")).toBe(false);
  });

  it("accepts a date the QUESTION supplies (question is part of the supported set)", () => {
    expect(answerAssertsUnsupportedDate("Yes, 2026-09-14 works.", [note("an unrelated 2026-09-13 note")], "is 2026-09-14 free?")).toBe(false);
  });
});

describe("chat citation precision/recall cues — ALCE parity on the chat surface", () => {
  const note = (source: string, text: string): KnowledgeMatch => ({ cosine: 0.8, score: 0.8, source, text });

  it("precision cue: warns when a cited source doesn't support its sentence", () => {
    const matches = [note("vpn.md", "the office vpn mtu is 1380 on wg0")];
    const cue = chatCitationPrecisionNotice("The office MTU is 1380 [from vpn.md]. The flight departs at gate twelve [from vpn.md].", matches);
    expect(cue).toBeDefined();
    expect(cue).toContain("Citation check");
    expect(cue).toContain("flight");
  });

  it("precision cue: silent when the cited source supports the sentence", () => {
    expect(chatCitationPrecisionNotice("The office MTU is 1380 [from vpn.md].", [note("vpn.md", "the office vpn mtu is 1380 on wg0")])).toBeUndefined();
  });

  it("recall cue: warns when a citable claim carries no citation", () => {
    const cue = chatCitationRecallNotice("The office MTU is 1380.", [note("vpn.md", "the office vpn mtu is 1380 on wg0")]);
    expect(cue).toBeDefined();
    expect(cue).toContain("Attribution check");
  });

  it("recall cue: silent when the claim is cited", () => {
    expect(chatCitationRecallNotice("The office MTU is 1380 [from vpn.md].", [note("vpn.md", "the office vpn mtu is 1380 on wg0")])).toBeUndefined();
  });
});
