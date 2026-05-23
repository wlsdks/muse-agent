import { describe, expect, it } from "vitest";

import {
  assembleKnowledgeCorpus,
  createNotesKnowledgeSearchTool,
  type FollowupLike,
  type FollowupsSource
} from "../src/knowledge-corpus.js";

const VOCAB = ["acme", "contract", "renewal", "vendor", "invoice"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

function followupsSource(followups: FollowupLike[]): FollowupsSource {
  return { list: () => followups };
}

const SAMPLE: FollowupLike[] = [
  { id: "f1", summary: "Follow up on the Acme contract renewal" },
  { id: "f2", summary: "Chase the vendor invoice" }
];

describe("assembleKnowledgeCorpus — scheduled followups as a corpus source", () => {
  it("emits each followup as a followup/<summary> chunk", async () => {
    const corpus = await assembleKnowledgeCorpus({ followupsSource: followupsSource(SAMPLE) });
    const acme = corpus.find((c) => c.source.startsWith("followup/") && c.text.includes("Acme"));
    expect(acme).toBeDefined();
    expect(acme!.source).toContain("followup/Follow up on the Acme contract renewal");
    expect(corpus.some((c) => c.source.startsWith("followup/") && c.text.includes("vendor invoice"))).toBe(true);
  });

  it("a throwing followups source degrades to no followup chunks (never crashes the corpus)", async () => {
    const source: FollowupsSource = { list: () => { throw new Error("followups unreadable"); } };
    const corpus = await assembleKnowledgeCorpus({ followupsSource: source });
    expect(corpus.filter((c) => c.source.startsWith("followup/"))).toHaveLength(0);
  });
});

describe("knowledge_search spans scheduled followups — answers + cites a followup", () => {
  it("answers 'anything about the acme renewal?' from the followup and cites it", async () => {
    const tool = createNotesKnowledgeSearchTool({ embed, followupsSource: followupsSource(SAMPLE) });
    const result = String(await tool.execute({ query: "anything about the acme contract renewal?" }, { runId: "r1" }));
    expect(result).toContain("[followup/Follow up on the Acme contract renewal]");
  });
});
