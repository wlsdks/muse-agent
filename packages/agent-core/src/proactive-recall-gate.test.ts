import { describe, expect, it } from "vitest";

import {
  createConfidenceGatedInvestigator,
  decideProactiveRecall
} from "./proactive-recall-gate.js";
import type { KnowledgeChunk, KnowledgeMatch } from "./knowledge-recall.js";

const match = (over: Partial<KnowledgeMatch>): KnowledgeMatch => ({
  cosine: 0.8,
  score: 0.8,
  source: "notes/q3.md",
  text: "Q3 budget review is on the 18th; bring the revised forecast.",
  ...over
});

describe("decideProactiveRecall — the CRAG gate for proactive surfacing", () => {
  it("surfaces a cited finding only when confident", () => {
    const d = decideProactiveRecall([match({ cosine: 0.72 })]);
    expect(d.surface).toBe(true);
    expect(d.confidence).toBe("confident");
    expect(d.finding).toContain("[notes/q3.md]");
    expect(d.finding).toContain("Q3 budget review");
  });

  it("stays SILENT on a weak (ambiguous) recall — never a low-confidence guess", () => {
    const d = decideProactiveRecall([match({ cosine: 0.4 })]);
    expect(d.surface).toBe(false);
    expect(d.confidence).toBe("ambiguous");
    expect(d.finding).toBeUndefined();
  });

  it("stays silent on an empty recall", () => {
    const d = decideProactiveRecall([]);
    expect(d).toMatchObject({ confidence: "none", surface: false });
    expect(d.finding).toBeUndefined();
  });

  it("quotes the STRONGEST match and truncates long passages", () => {
    const long = "x".repeat(400);
    const d = decideProactiveRecall(
      [match({ cosine: 0.62, source: "a.md", text: "weaker" }), match({ cosine: 0.9, source: "b.md", text: long })],
      { maxChars: 50 }
    );
    expect(d.finding).toContain("[b.md]");
    expect(d.finding).toContain("…");
    expect(d.finding!.length).toBeLessThan(120);
  });

  it("honours a custom confidence threshold", () => {
    expect(decideProactiveRecall([match({ cosine: 0.5 })], { confidentAt: 0.45 }).surface).toBe(true);
    expect(decideProactiveRecall([match({ cosine: 0.5 })], { confidentAt: 0.6 }).surface).toBe(false);
  });
});

describe("createConfidenceGatedInvestigator — investigate seam", () => {
  // A fake embedder: query/chunk map to fixed vectors so cosine is deterministic.
  const vectors: Record<string, readonly number[]> = {
    "Q3 budget review": [1, 0, 0],
    "Q3 budget review is on the 18th; bring the revised forecast.": [1, 0, 0],
    "Dentist appointment": [0, 1, 0],
    "My cat's vaccination schedule for next spring.": [0, 0, 1]
  };
  const embed = async (text: string): Promise<readonly number[]> => vectors[text] ?? [0, 0, 0];
  const chunks: KnowledgeChunk[] = [
    { source: "q3.md", text: "Q3 budget review is on the 18th; bring the revised forecast." },
    { source: "cat.md", text: "My cat's vaccination schedule for next spring." }
  ];

  it("returns a cited finding when the trigger topic IS in the corpus", async () => {
    const investigate = createConfidenceGatedInvestigator({ chunks, embed });
    const finding = await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" });
    expect(finding).toBeDefined();
    expect(finding).toContain("[q3.md]");
  });

  it("returns undefined (silent) when the trigger is off-topic for the corpus", async () => {
    const investigate = createConfidenceGatedInvestigator({ chunks, embed });
    const finding = await investigate({ factSheet: "", kind: "calendar", title: "Dentist appointment" });
    expect(finding).toBeUndefined();
  });

  it("fail-open: empty title / empty corpus / throwing embed → undefined", async () => {
    expect(await createConfidenceGatedInvestigator({ chunks, embed })({ factSheet: "", kind: "task", title: "  " })).toBeUndefined();
    expect(await createConfidenceGatedInvestigator({ chunks: [], embed })({ factSheet: "", kind: "task", title: "x" })).toBeUndefined();
    const boom = createConfidenceGatedInvestigator({ chunks, embed: async () => { throw new Error("down"); } });
    expect(await boom({ factSheet: "", kind: "task", title: "Q3 budget review" })).toBeUndefined();
  });
});
