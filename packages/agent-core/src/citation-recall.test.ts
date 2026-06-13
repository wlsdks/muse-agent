import { describe, expect, it } from "vitest";

import { reportCitationRecall } from "./citation-recall.js";
import type { KnowledgeMatch } from "./knowledge-recall.js";

const match = (source: string, text: string): KnowledgeMatch => ({ cosine: 0.7, score: 0.7, source, text });

describe("reportCitationRecall — ALCE citation recall (groundable-but-uncited claims)", () => {
  it("recall 0 when a citable claim carries NO citation (the silent missed attribution)", () => {
    const report = reportCitationRecall("The office MTU is 1380.", [match("vpn.md", "the office vpn mtu is 1380 on wg0")]);
    expect(report.recall).toBe(0);
    expect(report.citableCount).toBe(1);
    expect(report.citedCount).toBe(0);
    expect(report.uncited[0]).toContain("MTU");
  });

  it("recall 1 when the citable claim DOES carry a citation", () => {
    const report = reportCitationRecall("The office MTU is 1380 [from vpn.md].", [match("vpn.md", "the office vpn mtu is 1380 on wg0")]);
    expect(report.recall).toBe(1);
    expect(report.uncited).toEqual([]);
  });

  it("a sentence the evidence does NOT support is not citable → not counted (recall 1, no false 'uncited')", () => {
    const report = reportCitationRecall("The weather is sunny today.", [match("vpn.md", "the office vpn mtu is 1380")]);
    expect(report.citableCount).toBe(0);
    expect(report.recall).toBe(1);
    expect(report.uncited).toEqual([]);
  });

  it("mixed: one citable+cited, one citable+uncited → recall 0.5", () => {
    const report = reportCitationRecall(
      "The office MTU is 1380 [from vpn.md]. The office gateway is 10.0.0.1.",
      [match("vpn.md", "the office vpn mtu is 1380 and the office gateway is 10.0.0.1")]
    );
    expect(report.recall).toBe(0.5);
    expect(report.uncited).toHaveLength(1);
    expect(report.uncited[0]).toContain("gateway");
  });

  it("no evidence ⇒ nothing citable ⇒ recall 1 (an answer with no retrieved support isn't a recall failure)", () => {
    expect(reportCitationRecall("Some claim.", []).recall).toBe(1);
  });
});
