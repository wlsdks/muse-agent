import { describe, expect, it } from "vitest";

import { EMBEDDER_AB_CORPUS, scoreRetrievalRecall } from "./embedder-ab.js";
import type { KnowledgeMatch } from "@muse/agent-core";

const matchFor = (source: string): KnowledgeMatch => ({ cosine: 0.9, score: 0.9, source, text: "stub" });

describe("EMBEDDER_AB_CORPUS shape", () => {
  it("every case's expected source exists among the notes, and queries paraphrase (KO majority + EN controls)", () => {
    const sources = new Set(EMBEDDER_AB_CORPUS.notes.map((note) => note.source));
    expect(EMBEDDER_AB_CORPUS.cases.length).toBeGreaterThanOrEqual(12);
    for (const testCase of EMBEDDER_AB_CORPUS.cases) {
      expect(sources.has(testCase.expectedSource)).toBe(true);
    }
    const koCases = EMBEDDER_AB_CORPUS.cases.filter((c) => /[가-힣]/u.test(c.query));
    const enCases = EMBEDDER_AB_CORPUS.cases.filter((c) => !/[가-힣]/u.test(c.query));
    expect(koCases.length).toBeGreaterThanOrEqual(10);
    expect(enCases.length).toBeGreaterThanOrEqual(2);
  });
});

describe("scoreRetrievalRecall", () => {
  it("counts top-1 and top-K hits separately and names the misses", async () => {
    const cases = [
      { expectedSource: "a.md", query: "q1" },
      { expectedSource: "b.md", query: "q2" },
      { expectedSource: "c.md", query: "q3" }
    ];
    const ranked: Record<string, KnowledgeMatch[]> = {
      q1: [matchFor("a.md"), matchFor("x.md")],
      q2: [matchFor("x.md"), matchFor("b.md")],
      q3: [matchFor("x.md"), matchFor("y.md")]
    };
    const result = await scoreRetrievalRecall(cases, (query) => Promise.resolve(ranked[query] ?? []));
    expect(result.total).toBe(3);
    expect(result.hit1).toBe(1);
    expect(result.hitK).toBe(2);
    expect(result.misses).toEqual(["q3 → c.md"]);
  });
});

describe("multi-hop joint recall corpus + scorer", () => {
  it("corpus shape: every case names 2+ expected sources that exist among the notes", async () => {
    const { MULTIHOP_RECALL_CORPUS } = await import("./embedder-ab.js");
    const sources = new Set(MULTIHOP_RECALL_CORPUS.notes.map((n) => n.source));
    expect(MULTIHOP_RECALL_CORPUS.cases.length).toBeGreaterThanOrEqual(6);
    for (const c of MULTIHOP_RECALL_CORPUS.cases) {
      expect(c.expectedSources.length).toBeGreaterThanOrEqual(2);
      for (const src of c.expectedSources) expect(sources.has(src)).toBe(true);
    }
  });

  it("scoreJointRecall counts a case only when ALL expected sources surface in top-K", async () => {
    const { scoreJointRecall } = await import("./embedder-ab.js");
    const ranked: Record<string, { cosine: number; score: number; source: string; text: string }[]> = {
      q1: [{ cosine: 1, score: 1, source: "a.md", text: "x" }, { cosine: 1, score: 1, source: "b.md", text: "y" }],
      q2: [{ cosine: 1, score: 1, source: "a.md", text: "x" }]
    };
    const result = await scoreJointRecall(
      [
        { expectedSources: ["a.md", "b.md"], query: "q1" },
        { expectedSources: ["a.md", "b.md"], query: "q2" }
      ],
      (q) => Promise.resolve(ranked[q] ?? [])
    );
    expect(result.joint).toBe(1);
    expect(result.total).toBe(2);
    expect(result.misses).toEqual(["q2 → missing b.md"]);
  });
});
