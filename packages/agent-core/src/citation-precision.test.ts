import { describe, expect, it } from "vitest";

import { reportCitationPrecision } from "./citation-precision.js";
import type { KnowledgeMatch } from "./knowledge-recall.js";

const match = (source: string, text: string): KnowledgeMatch => ({ cosine: 0.7, score: 0.7, source, text });

describe("reportCitationPrecision — ALCE per-citation support (right source, wrong claim)", () => {
  it("flags a sentence whose cited source RESOLVES but does not support it (precision 0.5)", () => {
    const report = reportCitationPrecision(
      "The office MTU is 1380 [from vpn.md]. The flight departs from gate twelve [from vpn.md].",
      [match("vpn.md", "the office vpn mtu is 1380 on wg0")]
    );
    expect(report.precision).toBe(0.5);
    expect(report.unsupported).toHaveLength(1);
    expect(report.unsupported[0]).toContain("flight");
    const flightPair = report.pairs.find((p) => p.sentence.includes("flight"))!;
    expect(flightPair.resolved).toBe(true); // the cited source IS a retrieved match...
    expect(flightPair.supported).toBe(false); // ...but it doesn't support the sentence — the new, distinct check
  });

  it("precision 1.0 when every sentence's cited source supports it", () => {
    const report = reportCitationPrecision(
      "The office MTU is 1380 [from vpn.md].",
      [match("vpn.md", "the office vpn mtu is 1380 on wg0")]
    );
    expect(report.precision).toBe(1);
    expect(report.unsupported).toEqual([]);
  });

  it("a citation that does NOT resolve to a retrieved source is unsupported (resolved:false)", () => {
    const report = reportCitationPrecision(
      "The MTU is 1380 [from ghost.md].",
      [match("vpn.md", "the office vpn mtu is 1380")]
    );
    expect(report.precision).toBe(0);
    const pair = report.pairs[0]!;
    expect(pair.resolved).toBe(false);
    expect(pair.supported).toBe(false);
  });

  it("scores each sentence against its OWN cited source, not the union (cross-source claim caught)", () => {
    // The flight fact is in flights.md, but the sentence cites vpn.md — union-coverage
    // would pass (flight tokens exist SOMEWHERE); per-citation correctly fails.
    const report = reportCitationPrecision(
      "The flight departs from gate twelve [from vpn.md].",
      [match("vpn.md", "the office vpn mtu is 1380"), match("flights.md", "the flight departs from gate twelve")]
    );
    expect(report.precision).toBe(0);
    expect(report.unsupported).toHaveLength(1);
  });

  it("sentences with no citation contribute no pair (precision 1 on an uncited answer)", () => {
    const report = reportCitationPrecision("Just a general remark with no source.", [match("vpn.md", "irrelevant")]);
    expect(report.pairs).toEqual([]);
    expect(report.precision).toBe(1);
  });

  it("a faithful Korean paraphrase is supported despite agglutinative endings (live false-flag, 2026-07-17)", () => {
    // The note says "주문"/"예약"; a faithful answer inflects them ("주문하고"/
    // "예약하기로") — exact-token coverage measured 0.267 (< 0.5 floor) and
    // false-flagged every Korean ask. The ≥2-syllable stem-prefix match lifts
    // this pair to 0.733 without touching the shared tokenizer.
    const report = reportCitationPrecision(
      "생일 파티를 위해 Butter&Crumb에서 케이크를 주문하고, 미나와 준을 초대하며 토요일에 루프탑 테이블을 예약하기로 했습니다 [from birthday-plan.md].",
      [match("birthday-plan.md", "생일 파티 준비: Butter&Crumb에서 케이크 주문, 미나랑 준 초대, 토요일 루프탑 테이블 예약.")]
    );
    expect(report.pairs[0]!.supported).toBe(true);
    expect(report.pairs[0]!.coverage).toBeGreaterThan(0.6);
  });

  it("a fabricated Korean claim against the same note is still flagged (stem match must not wash out the gate)", () => {
    const report = reportCitationPrecision(
      "다음 주 화요일 오전에 치과 검진 예약이 있습니다 [from birthday-plan.md].",
      [match("birthday-plan.md", "생일 파티 준비: Butter&Crumb에서 케이크 주문, 미나랑 준 초대, 토요일 루프탑 테이블 예약.")]
    );
    expect(report.pairs[0]!.supported).toBe(false);
    expect(report.pairs[0]!.coverage).toBeLessThan(0.5);
  });

  it("single-syllable Hangul prefixes do not collide ('주문' never covers '주민')", () => {
    const report = reportCitationPrecision(
      "주민 등록 정보를 갱신했습니다 [from admin.md].",
      [match("admin.md", "주문 내역: 케이크")]
    );
    expect(report.pairs[0]!.supported).toBe(false);
  });

  it("aggregates ALL chunks of a cited source (a sentence supported by a DIFFERENT chunk of the same file is not false-flagged)", () => {
    // The same file is retrieved as two chunks; the SUPPORTING chunk comes first,
    // so a last-wins source map would score the sentence against the non-supporting
    // second chunk and wrongly report unsupported. Aggregation fixes it.
    const matches = [match("vpn.md", "the office mtu is 1380"), match("vpn.md", "an unrelated chunk about the coffee machine")];
    const report = reportCitationPrecision("The office MTU is 1380 [from vpn.md].", matches);
    expect(report.precision).toBe(1);
    expect(report.pairs[0]!.supported).toBe(true);
  });
});
