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
});
