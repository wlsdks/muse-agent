import { describe, expect, it } from "vitest";

import {
  extractCompactionAnchors,
  verifyCompactionSummaryQuality,
  type ConversationMessage
} from "../src/index.js";

const user = (content: string): ConversationMessage => ({ content, role: "user" });
const assistant = (content: string): ConversationMessage => ({ content, role: "assistant" });

describe("extractCompactionAnchors", () => {
  it("extracts a currency amount and tags it user-asserted (from a user message)", () => {
    const anchors = extractCompactionAnchors([user("my budget is $5,000 for the trip")]);
    const values = anchors.map((a) => a.value);
    expect(values.some((v) => v.includes("5,000"))).toBe(true);
    expect(anchors.find((a) => a.value.includes("5,000"))?.userAsserted).toBe(true);
  });

  it("extracts a Korean amount with unit suffix (reused extractSalientFacts NUMERIC pattern)", () => {
    const anchors = extractCompactionAnchors([user("예산은 1,250만원 확정")]);
    expect(anchors.some((a) => a.value.includes("1,250만원"))).toBe(true);
  });

  it("extracts an ISO date", () => {
    const anchors = extractCompactionAnchors([user("the deadline is 2026-07-07")]);
    expect(anchors.some((a) => a.value === "2026-07-07")).toBe(true);
  });

  it("extracts a Korean number+classifier phrase not covered by the unit-suffix pattern (e.g. 3동, 5층)", () => {
    const anchors = extractCompactionAnchors([user("우리집은 3동 5층이야")]);
    const values = anchors.map((a) => a.value);
    expect(values).toContain("3동");
    expect(values).toContain("5층");
  });

  it("extracts a quoted string", () => {
    const anchors = extractCompactionAnchors([user('call the project "Ironclad" from now on')]);
    expect(anchors.some((a) => a.value === "Ironclad")).toBe(true);
  });

  it("extracts a snake_case code identifier", () => {
    const anchors = extractCompactionAnchors([assistant("the flag is max_retry_count in config.py")]);
    expect(anchors.some((a) => a.value === "max_retry_count")).toBe(true);
  });

  it("extracts a camelCase code identifier", () => {
    const anchors = extractCompactionAnchors([assistant("set maxRetryCount to 3 before shipping")]);
    expect(anchors.some((a) => a.value === "maxRetryCount")).toBe(true);
  });

  it("extracts a bare capitalized proper noun (English) — a heuristic, not an NER model", () => {
    const anchors = extractCompactionAnchors([user("please call Jinan about the invoice")]);
    expect(anchors.some((a) => a.value === "Jinan")).toBe(true);
  });

  it("extracts a decision line (DECISION category, reused from extractSalientFacts) and marks it fuzzy-matchable", () => {
    const anchors = extractCompactionAnchors([user("we decided to ship on Friday, no exceptions")]);
    const anchor = anchors.find((a) => a.value.toLowerCase().includes("decided to ship on friday"));
    expect(anchor).toBeDefined();
    expect(anchor?.fuzzy).toBe(true);
  });

  it("does NOT flag an ordinary sentence-initial capitalized word as a proper-noun anchor", () => {
    // "Quick update: …" — "Quick" is capitalized only because it opens the
    // sentence, not because it's a name. Excluding message-initial position
    // (rather than an ever-growing stopword list) fixes the false positive.
    const anchors = extractCompactionAnchors([user("Quick update: nothing new to report today")]);
    expect(anchors.some((a) => a.value === "Quick")).toBe(false);
  });

  it("tags an assistant-only anchor as NOT user-asserted", () => {
    const anchors = extractCompactionAnchors([
      user("what's the status?"),
      assistant("the server cost is $9,999 this month")
    ]);
    const anchor = anchors.find((a) => a.value.includes("9,999"));
    expect(anchor).toBeDefined();
    expect(anchor?.userAsserted).toBe(false);
  });

  it("excludes tool-role turns entirely (trust boundary)", () => {
    const anchors = extractCompactionAnchors([
      { content: "", role: "assistant", toolCalls: [{ arguments: {}, id: "c1", name: "search" }] },
      { content: "found $99,999 in the vault", role: "tool", toolCallId: "c1" }
    ]);
    expect(anchors.some((a) => a.value.includes("99,999"))).toBe(false);
  });

  it("honest heuristic limit: a lowercase Korean name with no trailing digit/classifier is NOT reliably captured", () => {
    // Korean has no capitalization signal, so a bare name like "지안" with no
    // adjoining number/classifier and no quotes/domain-noun is invisible to
    // this extractor — documented here rather than silently overclaiming.
    const anchors = extractCompactionAnchors([user("지안한테 물어봐야겠다")]);
    expect(anchors.some((a) => a.value.includes("지안"))).toBe(false);
  });
});

describe("verifyCompactionSummaryQuality", () => {
  const dropped = [
    user('the invoice for "Ironclad" is $5,000, due 2026-07-07'),
    assistant("noted — I'll set max_retry_count to 3 for the retries")
  ];

  it("passes vacuously when there are no anchors to lose", () => {
    const result = verifyCompactionSummaryQuality([user("hi there"), assistant("hello!")], "small talk exchange");
    expect(result.passed).toBe(true);
    expect(result.totalAnchors).toBe(0);
  });

  it("passes when the summary preserves the user-asserted anchors and enough overall coverage", () => {
    const result = verifyCompactionSummaryQuality(
      dropped,
      'Discussed the "Ironclad" invoice: $5,000, due 2026-07-07. Also set max_retry_count to 3.'
    );
    expect(result.passed).toBe(true);
    expect(result.missingUserAnchors).toEqual([]);
  });

  it("fails closed when a user-asserted anchor is missing, even if overall coverage looks fine", () => {
    // The summary keeps the assistant's retry detail but drops the user's own
    // invoice amount/name/date entirely — user's own words must always survive.
    const result = verifyCompactionSummaryQuality(
      dropped,
      "Set max_retry_count to 3 for the retries."
    );
    expect(result.passed).toBe(false);
    expect(result.missingUserAnchors.length).toBeGreaterThan(0);
  });

  it("covers a decision anchor via paraphrase (word overlap), not requiring the exact sentence", () => {
    // A real aux summarizer paraphrases decision lines rather than repeating
    // them verbatim — that's the whole point of summarizing. The gate must
    // still recognize a faithful paraphrase as covering the decision.
    const decisionDropped = [user("we decided to sign the contract with Ironbridge Logistics for the shipment")];
    const paraphrasedSummary = "The team confirmed a decision to sign the contract with Ironbridge Logistics.";
    const result = verifyCompactionSummaryQuality(decisionDropped, paraphrasedSummary);
    expect(result.passed).toBe(true);
  });

  it("still rejects when a decision anchor's paraphrase drops most of its content words", () => {
    const decisionDropped = [user("we decided to sign the contract with Ironbridge Logistics for the shipment")];
    const vagueSummary = "some things were discussed.";
    const result = verifyCompactionSummaryQuality(decisionDropped, vagueSummary);
    expect(result.passed).toBe(false);
  });

  it("fails closed when overall coverage is below the configured ratio", () => {
    const manyAnchorDropped = [
      user('budget "Ironclad" is $5,000 due 2026-07-07, code max_retry_count, contact Jinan, unit 3동'),
    ];
    const thinSummary = "discussed the budget briefly";
    const result = verifyCompactionSummaryQuality(manyAnchorDropped, thinSummary, { minCoverageRatio: 0.6 });
    expect(result.passed).toBe(false);
    expect(result.coverageRatio).toBeLessThan(0.6);
  });

  it("respects a custom minCoverageRatio (assistant-only anchors, so the user-asserted 100% rule doesn't dominate)", () => {
    const manyAnchorDropped = [
      user("what's the status?"),
      assistant('budget "Ironclad" is $5,000 due 2026-07-07, code max_retry_count, unit 3동')
    ];
    // A summary mentioning just the amount clears a very low bar but not a high one.
    const partialSummary = "budget is $5,000";
    const lenient = verifyCompactionSummaryQuality(manyAnchorDropped, partialSummary, { minCoverageRatio: 0.1 });
    const strict = verifyCompactionSummaryQuality(manyAnchorDropped, partialSummary, { minCoverageRatio: 0.9 });
    expect(lenient.passed).toBe(true);
    expect(strict.passed).toBe(false);
  });
});
