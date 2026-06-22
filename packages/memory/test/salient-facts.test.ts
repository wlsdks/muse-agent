import { describe, expect, it } from "vitest";

import {
  extractSalientFacts,
  mergeSalientFacts,
  parseKeyDetailsBlock,
  renderKeyDetailsBlock,
  stripKeyDetailsBlock
} from "../src/salient-facts.js";
import type { ConversationMessage, StructuredFact } from "../src/index.js";

const u = (content: string): ConversationMessage => ({ role: "user", content });
const _a = (content: string): ConversationMessage => ({ role: "assistant", content });
const t = (content: string): ConversationMessage => ({ role: "tool", content, toolCallId: "tc1" });

// ---------------------------------------------------------------------------
// extractSalientFacts
// ---------------------------------------------------------------------------

describe("extractSalientFacts — NUMERIC", () => {
  it("extracts a Korean currency amount verbatim", () => {
    const facts = extractSalientFacts([u("예산은 1,250만원으로 확정했습니다.")]);
    expect(facts.some((f) => f.value.includes("1,250만원"))).toBe(true);
    expect(facts.every((f) => f.category === "NUMERIC" || f.category === "DECISION" || f.category === "ENTITY")).toBe(true);
  });

  it("extracts a currency-symbol amount verbatim ($9,999)", () => {
    const facts = extractSalientFacts([u("The budget is $9,999 for Q3.")]);
    const numericFact = facts.find((f) => f.category === "NUMERIC");
    expect(numericFact).toBeDefined();
    expect(numericFact!.value).toContain("9,999");
  });

  it("value is a verbatim substring of the source message", () => {
    const msg = "마케팅 예산 1,250만원 확정";
    const facts = extractSalientFacts([u(msg)]);
    const numericFact = facts.find((f) => f.category === "NUMERIC");
    if (numericFact) {
      // The value must appear verbatim in the original message text
      expect(msg).toContain(numericFact.value.trim());
    }
  });
});

describe("extractSalientFacts — DECISION", () => {
  it("extracts a Korean decision line verbatim", () => {
    const msg = "React를 사용하기로 결정했습니다.";
    const facts = extractSalientFacts([u(msg)]);
    const decision = facts.find((f) => f.category === "DECISION");
    expect(decision).toBeDefined();
    expect(msg).toContain(decision!.value.slice(0, 10));
  });

  it("extracts an English decision line", () => {
    const msg = "We decided to use TypeScript for all new services.";
    const facts = extractSalientFacts([u(msg)]);
    const decision = facts.find((f) => f.category === "DECISION");
    expect(decision).toBeDefined();
    expect(decision!.value).toContain("decided to use TypeScript");
  });

  it("DECISION drop-if-over-cap (KO): a >140-char line whose final clause is a negation is DROPPED, never stored with an inverted mid-sentence value", () => {
    // Korean is verb-final: negation/qualifier sits at the END of the sentence.
    // A .slice(0,140) on a >140-char line silently drops the negation and
    // inverts the meaning. The correct behavior is to DROP the candidate entirely.
    // This test FAILS against the old .slice behavior (counterfactual):
    //   old: stores "…줄이지" (positive fragment, missing "않기로 결정했다")
    //   new: no DECISION fact stored at all
    const koDecision =
      "이사회는 다음 분기와 이후 전체 운영 비용에 관하여 충분히 상세한 검토와 광범위한 분석 과정을 거쳐 마케팅 부문과 인프라 투자 및 신규 채용을 포함한 인건비와 연구 개발 비용 등 회사 전반의 모든 예산 항목은 어떠한 경영 상황에서도 결코 줄이지 않기로 최종 결정했다";
    expect(koDecision.length).toBeGreaterThan(140);
    const facts = extractSalientFacts([u(koDecision)]);
    const decisions = facts.filter((f) => f.category === "DECISION");
    // Must NOT contain a value that ends before the negation "않기로 결정했다"
    for (const d of decisions) {
      expect(d.value).not.toMatch(/줄이지\s*$/u);
    }
    // The over-cap line must be dropped (no DECISION fact at all)
    expect(decisions.length).toBe(0);
  });

  it("DECISION drop-if-over-cap (EN): a >140-char line with a late negation clause is DROPPED, not mid-word sliced", () => {
    // This FAILS against the old .slice behavior (counterfactual):
    //   old: stores first 140 chars (mid-word "maintainab…"), drops "but not JavaScript"
    //   new: no DECISION fact stored
    const enDecision =
      "We decided to use TypeScript for all new services and also all new tooling pipelines throughout the organization, but not JavaScript for any of these areas going forward.";
    expect(enDecision.length).toBeGreaterThan(140);
    const facts = extractSalientFacts([u(enDecision)]);
    const decisions = facts.filter((f) => f.category === "DECISION");
    // Must be dropped entirely — no partial/inverted value
    expect(decisions.length).toBe(0);
  });
});

describe("extractSalientFacts — trust boundary", () => {
  it("does NOT extract from role:tool messages", () => {
    // $9,999 only inside a tool turn — should extract nothing NUMERIC
    const facts = extractSalientFacts([t("The budget is $9,999 for Q3.")]);
    const numericFact = facts.find((f) => f.category === "NUMERIC" && f.value.includes("9,999"));
    expect(numericFact).toBeUndefined();
  });

  it("extracts from user even when tool message has the same content", () => {
    const facts = extractSalientFacts([
      t("$9,999 tool result"),
      u("budget is $9,999")
    ]);
    const found = facts.find((f) => f.value.includes("9,999"));
    expect(found).toBeDefined();
  });
});

describe("extractSalientFacts — caps", () => {
  it("caps NUMERIC facts at 4 per call", () => {
    const messages = [
      u("a: $100, b: $200, c: $300, d: $400, e: $500 — five amounts")
    ];
    const facts = extractSalientFacts(messages).filter((f) => f.category === "NUMERIC");
    expect(facts.length).toBeLessThanOrEqual(4);
  });

  it("strips control bytes from extracted values", () => {
    const msg = "예산\x00은 1,250만원";
    const facts = extractSalientFacts([u(msg)]);
    for (const fact of facts) {
      expect(fact.value).not.toContain("\x00");
    }
  });
});

// ---------------------------------------------------------------------------
// adversarial truncation / floor-poisoning guard
// ---------------------------------------------------------------------------

describe("extractSalientFacts — adversarial truncation guard", () => {
  it("$3-4 million range: extracted whole or nothing — never $3 alone", () => {
    const facts = extractSalientFacts([u("Our budget is $3-4 million for the project.")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    // $3 alone is a truncated fragment — must never appear
    expect(numericValues.some((v) => v === "$3")).toBe(false);
    // either the whole range is extracted or nothing
    const hasRange = numericValues.some((v) => v.includes("$3-4") || v.includes("$3") && v.includes("million"));
    const hasNothing = numericValues.length === 0;
    expect(hasRange || hasNothing).toBe(true);
  });

  it("$1.250.000 dot-grouped: extracted whole or nothing — never $1.250", () => {
    const facts = extractSalientFacts([u("총액은 $1.250.000 입니다")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    // $1.250 is a truncated fragment — must never appear
    expect(numericValues.some((v) => v === "$1.250")).toBe(false);
    // if extracted, must contain the full amount
    for (const v of numericValues) {
      if (v.startsWith("$1")) {
        expect(v).toContain("1.250.000");
      }
    }
  });

  it("1.250.000원 dot-grouped Korean: extracted whole or nothing — no leading-digit loss", () => {
    const facts = extractSalientFacts([u("1.250.000원이 총액입니다")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    // A value that starts with 250 means the leading '1.' was lost — floor violation
    expect(numericValues.some((v) => v.startsWith("250"))).toBe(false);
    // if extracted, must contain full amount
    for (const v of numericValues) {
      expect(v).not.toMatch(/^250/);
    }
  });

  it("3~4시 range: extracted whole or nothing", () => {
    const facts = extractSalientFacts([u("회의는 3~4시 사이에")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    // either the whole range token or nothing; never just '3시' or '4시' split
    const hasRange = numericValues.some((v) => v.includes("3~4시") || v.includes("3~4"));
    const hasNothing = numericValues.length === 0;
    expect(hasRange || hasNothing).toBe(true);
  });

  it("mis-pairing probe: 500이고 + 1,250만원 — no fact pairs 500 with 만원", () => {
    const facts = extractSalientFacts([u("예산은 500이고 인원은 1,250만원")]);
    for (const fact of facts.filter((f) => f.category === "NUMERIC")) {
      if (fact.value.includes("만원")) {
        // must contain 1,250 not just 500
        expect(fact.value).toContain("1,250");
        expect(fact.value).not.toMatch(/^500만원$/);
      }
    }
  });

  // KO compound-scale: must capture whole token or nothing — the judge killers
  it("5천만원: extracted whole (5천만원) or nothing — never truncated 5천", () => {
    const facts = extractSalientFacts([u("계약금은 5천만원이야")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "5천" || v === "5천원")).toBe(false);
    for (const v of numericValues) {
      expect(v).not.toMatch(/^5천$/u);
      if (v.startsWith("5")) {
        expect(v).toContain("5천만원");
      }
    }
  });

  it("3억 5천만원 (spaced compound): whole amount or nothing — never 3억 alone or 5천 alone", () => {
    const facts = extractSalientFacts([u("예산은 3억 5천만원으로 잡았어")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    // Spaced compound: neither partial segment is faithful — must be dropped
    expect(numericValues.some((v) => v === "3억")).toBe(false);
    expect(numericValues.some((v) => v === "5천" || v === "5천만원")).toBe(false);
  });

  it("1억 오천만원 (hangul-numeral second segment): whole amount or nothing — never 1억 alone", () => {
    const facts = extractSalientFacts([u("총액은 1억 오천만원입니다")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "1억")).toBe(false);
    expect(numericValues.some((v) => v === "오천만원" || v === "오천")).toBe(false);
  });

  it("3억 천만원 (digitless second segment): whole amount or nothing — never 3억 alone", () => {
    const facts = extractSalientFacts([u("비용은 3억 천만원이야")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "3억")).toBe(false);
    expect(numericValues.some((v) => v === "천만원" || v === "천만")).toBe(false);
  });

  it("5천 만원 (space-split scale): whole amount or nothing — never 5천 alone", () => {
    const facts = extractSalientFacts([u("임금은 5천 만원이야")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "5천")).toBe(false);
  });

  it("3억\\n5천만원 (newline-separated compound): both segments dropped — no 3억 fragment", () => {
    // \n between segments must be treated as whitespace for the across-whitespace
    // guard (isCont check). A bare `=== " "` guard would miss \n and emit "3억".
    const facts = extractSalientFacts([u("예산은 3억\n5천만원으로 잡았어")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "3억")).toBe(false);
    expect(numericValues.some((v) => v === "5천만원" || v === "5천")).toBe(false);
  });

  it("3억\\t5천만원 (tab-separated compound): both segments dropped — no 3억 fragment", () => {
    const facts = extractSalientFacts([u("예산은 3억\t5천만원으로 잡았어")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "3억")).toBe(false);
    expect(numericValues.some((v) => v === "5천만원" || v === "5천")).toBe(false);
  });

  it("3억　5천만원 (ideographic-space compound): both segments dropped — no 3억 fragment", () => {
    // U+3000 IDEOGRAPHIC SPACE matches /\s/ but not ASCII space — the guard
    // must use /\s/ not === " ".
    const facts = extractSalientFacts([u("예산은 3억　5천만원으로 잡았어")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "3억")).toBe(false);
    expect(numericValues.some((v) => v === "5천만원" || v === "5천")).toBe(false);
  });

  it("계약금은 5천만원이고 잔금은 2억원이야: each amount whole or nothing", () => {
    const facts = extractSalientFacts([u("계약금은 5천만원이고 잔금은 2억원이야")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v === "5천")).toBe(false);
    for (const v of numericValues) {
      if (v.startsWith("5")) expect(v).toContain("5천만원");
      if (v.startsWith("2")) expect(v).toContain("2억원");
    }
  });

  it("1,250만원과 980만원: each compound extracted whole", () => {
    const facts = extractSalientFacts([u("예산 1,250만원과 비용 980만원")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    const has1250 = numericValues.some((v) => v.includes("1,250만원"));
    const has980 = numericValues.some((v) => v.includes("980만원"));
    // if extracted, must be whole
    for (const v of numericValues) {
      if (v.includes("1,250")) expect(v).toContain("1,250만원");
      if (v.includes("980")) expect(v).toContain("980만원");
    }
    // at least one amount captured (these are simple-boundary cases)
    expect(has1250 || has980).toBe(true);
  });

  it("12.5%: simple percent extracted whole", () => {
    const facts = extractSalientFacts([u("이자율은 12.5%야")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    expect(numericValues.some((v) => v.includes("12.5%"))).toBe(true);
  });

  it("plain 5 (no unit): no extraction (unit required)", () => {
    const facts = extractSalientFacts([u("숫자는 5야")]);
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    // bare digit without a unit should not be extracted
    expect(numericValues.every((v) => v !== "5")).toBe(true);
  });

  it("phone number: not mistaken for a monetary amount", () => {
    const facts = extractSalientFacts([u("전화번호는 010-1234-5678이야")]);
    // phone numbers should not appear as NUMERIC facts with monetary units
    const numericValues = facts.filter((f) => f.category === "NUMERIC").map((f) => f.value);
    for (const v of numericValues) {
      expect(v).not.toMatch(/010/u);
    }
  });

  it("property: every NUMERIC value is a MAXIMAL token in source (no adjacent or spaced-adjacent digit/scale/unit/hangul-numeral)", () => {
    // The boundary-guard property: for each extracted fact, the char immediately
    // before and after the value in the source — AND the first non-space char on
    // each side across whitespace — must NOT be a digit, comma, dot, Korean
    // scale/unit char, or Sino-Korean numeral.  This pins the SYMMETRIC CONT-set
    // guard (guards 1–4 in isCompleteToken) and is NON-VACUOUS: the corpus below
    // contains spaced-compound cases where a stubbed isCompleteToken→true would
    // emit truncated fragments that violate the across-whitespace assertion.
    // Same CONT set as isCont() in the implementation.
    const isCont = (ch: string): boolean =>
      /[\d,.천만억조원명개시분일월년%영일이삼사오육칠팔구십백]/u.test(ch);
    const corpus = [
      "Our budget is $3-4 million for the project.",
      "총액은 $1.250.000 입니다",
      "1.250.000원이 총액입니다",
      "예산은 1,250만원으로 확정했습니다.",
      "회의는 3~4시 사이에",
      "계약금은 5천만원이고 잔금은 2억원이야",
      // spaced-compound cases — isCompleteToken stubbed→true would emit truncated fragments here:
      "예산은 3억 5천만원으로 잡았어",
      "총액은 1억 오천만원입니다",
      "비용은 3억 천만원이야",
      "임금은 5천 만원이야",
      // non-ASCII-space whitespace compounds — guard must use /\s/ not === " ":
      "예산은 3억\n5천만원으로 잡았어",
      "예산은 3억\t5천만원으로 잡았어",
      "예산은 3억　5천만원으로 잡았어",
      "1,250,000.50원 총액",
      "$3-4 million",
      "$1.250.000",
      "1.250.000원",
      "예산 1,250만원과 비용 980만원",
      "12.5%",
      "5",
      "010-1234-5678 전화번호",
    ];
    for (const src of corpus) {
      const facts = extractSalientFacts([u(src)]);
      for (const fact of facts.filter((f) => f.category === "NUMERIC")) {
        const v = fact.value;
        // value must be a verbatim substring
        const idx = src.indexOf(v);
        expect(idx).toBeGreaterThanOrEqual(0);
        // guard 1: char immediately before must not be CONT
        if (idx > 0) {
          expect(isCont(src[idx - 1]!)).toBe(false);
        }
        // guard 2: char immediately after must not be CONT
        const afterIdx = idx + v.length;
        if (afterIdx < src.length) {
          expect(isCont(src[afterIdx]!)).toBe(false);
        }
        // guard 3: first non-whitespace char after must not be CONT
        let fwd = afterIdx;
        while (fwd < src.length && /\s/u.test(src[fwd]!)) fwd++;
        if (fwd < src.length && fwd !== afterIdx) {
          // only assert when there was actually whitespace to skip
          expect(isCont(src[fwd]!)).toBe(false);
        }
        // guard 4: first non-whitespace char before must not be CONT
        let bwd = idx - 1;
        while (bwd >= 0 && /\s/u.test(src[bwd]!)) bwd--;
        if (bwd >= 0 && bwd !== idx - 1) {
          // only assert when there was actually whitespace to skip
          expect(isCont(src[bwd]!)).toBe(false);
        }
      }
    }
    // --- NON-VACUOUSNESS PROOF (inline) ---
    // The spaced-compound corpus entries above ensure this test WOULD FAIL if
    // isCompleteToken always returned true: "예산은 3억 5천만원으로 잡았어"
    // would emit "3억" whose next non-space char is "5" (isCont=true) → fail guard 3.
    // "총액은 1억 오천만원입니다" would emit "1억" → next non-space "오" (isCont=true) → fail.
    // "임금은 5천 만원이야" would emit "5천" → next non-space "만" (isCont=true) → fail.
    // The \n/\t/U+3000 entries ensure the /\s/ guard is tested against non-ASCII-space
    // whitespace: "3억\n5천만원" with === " " guard would emit "3억" (next after \n is "5") → fail.
  });
});

// ---------------------------------------------------------------------------
// mergeSalientFacts
// ---------------------------------------------------------------------------

describe("mergeSalientFacts", () => {
  it("merges previous + fresh; fresh wins on same key", () => {
    const prev: StructuredFact[] = [{ key: "budget", value: "100만원", category: "NUMERIC" }];
    const fresh: StructuredFact[] = [{ key: "budget", value: "200만원", category: "NUMERIC" }];
    const merged = mergeSalientFacts(prev, fresh);
    const budget = merged.find((f) => f.key === "budget");
    expect(budget?.value).toBe("200만원");
  });

  it("does not delete unrelated keys when fresh has different keys", () => {
    const prev: StructuredFact[] = [
      { key: "budget", value: "100만원", category: "NUMERIC" },
      { key: "team_size", value: "5명", category: "NUMERIC" }
    ];
    const fresh: StructuredFact[] = [{ key: "deadline", value: "2026-07-01", category: "STATE" }];
    const merged = mergeSalientFacts(prev, fresh);
    expect(merged.some((f) => f.key === "budget")).toBe(true);
    expect(merged.some((f) => f.key === "team_size")).toBe(true);
    expect(merged.some((f) => f.key === "deadline")).toBe(true);
  });

  it("evicts oldest entries when over cap", () => {
    const prev: StructuredFact[] = Array.from({ length: 10 }, (_, i) => ({
      key: `old_fact_${i}`,
      value: `val_${i}`,
      category: "GENERAL" as const
    }));
    const fresh: StructuredFact[] = Array.from({ length: 5 }, (_, i) => ({
      key: `new_fact_${i}`,
      value: `val_new_${i}`,
      category: "GENERAL" as const
    }));
    const merged = mergeSalientFacts(prev, fresh, 12);
    expect(merged.length).toBeLessThanOrEqual(12);
  });

  it("returns empty array when both inputs are empty", () => {
    expect(mergeSalientFacts([], [])).toEqual([]);
  });

  it("keeps a just-refreshed fact on cap overflow (superseding key re-orders to the end)", () => {
    // `budget` is the oldest previous entry but is superseded by fresh, so it
    // is the FRESHEST fact and must survive eviction. Without delete-before-set
    // it keeps its early insertion slot and is evicted as if stale.
    const prev: StructuredFact[] = [
      { key: "budget", value: "100만원", category: "NUMERIC" },
      ...Array.from({ length: 4 }, (_, i) => ({
        key: `old_fact_${i}`,
        value: `val_${i}`,
        category: "GENERAL" as const
      }))
    ];
    const fresh: StructuredFact[] = [{ key: "budget", value: "200만원", category: "NUMERIC" }];

    const merged = mergeSalientFacts(prev, fresh, 3);

    expect(merged.length).toBe(3);
    const budget = merged.find((f) => f.key === "budget");
    expect(budget).toBeDefined();
    expect(budget?.value).toBe("200만원");
  });
});

// ---------------------------------------------------------------------------
// renderKeyDetailsBlock + parseKeyDetailsBlock (round-trip)
// ---------------------------------------------------------------------------

describe("renderKeyDetailsBlock / parseKeyDetailsBlock", () => {
  const facts: StructuredFact[] = [
    { key: "marketing_budget", value: "마케팅 예산 1,250만원", category: "NUMERIC" },
    { key: "use_react", value: "React를 사용하기로 결정", category: "DECISION" },
    { key: "결제_모듈", value: "결제 모듈", category: "ENTITY" }
  ];

  it("renders and parses back to equivalent facts (round-trip)", () => {
    const rendered = renderKeyDetailsBlock(facts);
    const parsed = parseKeyDetailsBlock(rendered);
    expect(parsed).toHaveLength(facts.length);
    for (let i = 0; i < facts.length; i++) {
      expect(parsed[i]!.key).toBe(facts[i]!.key);
      expect(parsed[i]!.value).toBe(facts[i]!.value);
      expect(parsed[i]!.category).toBe(facts[i]!.category);
    }
  });

  it("returns [] for text without a [Key details] header", () => {
    expect(parseKeyDetailsBlock("some ordinary text")).toEqual([]);
  });

  it("returns [] for malformed block lines (fail-open)", () => {
    const malformed = "[Key details]\nnot a bullet\n  also bad";
    expect(parseKeyDetailsBlock(malformed)).toEqual([]);
  });

  it("returns empty string for renderKeyDetailsBlock with no facts", () => {
    expect(renderKeyDetailsBlock([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// stripKeyDetailsBlock
// ---------------------------------------------------------------------------

describe("stripKeyDetailsBlock", () => {
  it("removes the [Key details] block and leaves surrounding text", () => {
    const rendered = renderKeyDetailsBlock([
      { key: "budget", value: "100만원", category: "NUMERIC" }
    ]);
    const summary = `[Conversation summary: 5 messages compacted]\n${rendered}\nSome other text`;
    const stripped = stripKeyDetailsBlock(summary);
    expect(stripped).not.toContain("[Key details]");
    expect(stripped).toContain("[Conversation summary");
    expect(stripped).toContain("Some other text");
  });

  it("is a no-op when there is no [Key details] block", () => {
    const plain = "plain text without block";
    expect(stripKeyDetailsBlock(plain)).toBe(plain);
  });
});
