import { describe, expect, it } from "vitest";

import {
  assembleKnowledgeCorpus,
  createNotesKnowledgeSearchTool,
  type FeedEntryLike,
  type FeedsKnowledgeSource
} from "../src/knowledge-corpus.js";

const VOCAB = ["acme", "merger", "outage", "rail", "release"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

function feedsSource(entries: FeedEntryLike[]): FeedsKnowledgeSource {
  return { recentEntries: () => entries };
}

const SAMPLE: FeedEntryLike[] = [
  { feedName: "Tech News", id: "e1", publishedAt: "2026-05-22T08:00:00Z", summary: "Acme announces a merger with Globex.", title: "Acme to merge with Globex" },
  { feedName: "Ops Status", id: "e2", publishedAt: "2026-05-23T09:00:00Z", summary: "Rail service restored after the morning outage.", title: "Rail outage cleared" }
];

describe("assembleKnowledgeCorpus — watched feed entries as a corpus source", () => {
  it("emits each feed entry as a feed/<title> chunk, prefixed with the feed name", async () => {
    const corpus = await assembleKnowledgeCorpus({ feedsSource: feedsSource(SAMPLE) });
    const merger = corpus.find((c) => c.source.startsWith("feed/") && c.text.includes("merger"));
    expect(merger).toBeDefined();
    expect(merger!.source).toContain("feed/Acme to merge with Globex");
    expect(merger!.text).toContain("Tech News: Acme to merge with Globex");
    expect(corpus.some((c) => c.source.startsWith("feed/") && c.text.includes("Rail outage"))).toBe(true);
  });

  it("a throwing feeds source degrades to no feed chunks (never crashes the corpus)", async () => {
    const source: FeedsKnowledgeSource = { recentEntries: () => { throw new Error("feeds unreadable"); } };
    const corpus = await assembleKnowledgeCorpus({ feedsSource: source });
    expect(corpus.filter((c) => c.source.startsWith("feed/"))).toHaveLength(0);
  });
});

describe("knowledge_search spans watched feeds — answers + cites a feed entry", () => {
  it("answers 'any news about the acme merger?' from the feed and cites it", async () => {
    const tool = createNotesKnowledgeSearchTool({ embed, feedsSource: feedsSource(SAMPLE) });
    const result = String(await tool.execute({ query: "any news about the acme merger?" }, { runId: "r1" }));
    expect(result).toContain("[feed/Acme to merge with Globex]");
  });
});
