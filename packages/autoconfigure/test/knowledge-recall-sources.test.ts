import { describe, expect, it } from "vitest";

import {
  assembleKnowledgeCorpus,
  createNotesKnowledgeSearchTool,
  type EpisodesKnowledgeSource,
  type UserMemoryKnowledgeSource
} from "../src/knowledge-corpus.js";

// SB-1 unified recall: episodes (past session summaries) and user-memory
// (auto-extracted facts/prefs) are the two stores that hold "what I told
// Muse about myself" — they were the gap in the knowledge corpus. These
// tests prove they now flow in, with source citations, and that a fact
// living ONLY in them is retrievable via knowledge_search.

const VOCAB = ["blood", "negative", "acme", "renewal", "friday", "tabby"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

describe("assembleKnowledgeCorpus — episodes as a corpus source", () => {
  it("emits session summaries as episode/<when> chunks, skipping blank ones", async () => {
    const episodesSource: EpisodesKnowledgeSource = {
      recentEpisodes: () => [
        { id: "e1", summary: "We discussed renewing the Acme contract by Friday.", when: "2026-05-20" },
        { id: "e2", summary: "   ", when: "2026-05-21" } // blank → skipped
      ]
    };
    const corpus = await assembleKnowledgeCorpus({ episodesSource });
    const bySource = new Map(corpus.map((c) => [c.source, c.text]));
    expect(bySource.get("episode/2026-05-20")).toContain("Acme contract");
    expect(bySource.get("episode/2026-05-20")).toContain("(2026-05-20)");
    expect(bySource.has("episode/2026-05-21")).toBe(false);
  });

  it("is fail-open: a throwing episodes source yields no chunks (never crashes recall)", async () => {
    const episodesSource: EpisodesKnowledgeSource = {
      recentEpisodes: () => { throw new Error("episode store unreadable"); }
    };
    await expect(assembleKnowledgeCorpus({ episodesSource })).resolves.toEqual([]);
  });
});

describe("assembleKnowledgeCorpus — user-memory as a corpus source", () => {
  it("emits remembered facts as memory/<kind:key> chunks, skipping empty values", async () => {
    const userMemorySource: UserMemoryKnowledgeSource = {
      facts: () => [
        { key: "blood_type", kind: "fact", value: "O-negative" },
        { key: "tone", kind: "preference", value: "" }, // empty → skipped
        { key: "city", value: "Seoul" } // no kind → memory/city
      ]
    };
    const corpus = await assembleKnowledgeCorpus({ userMemorySource });
    const bySource = new Map(corpus.map((c) => [c.source, c.text]));
    expect(bySource.get("memory/fact:blood_type")).toBe("blood_type: O-negative");
    expect(bySource.get("memory/city")).toBe("city: Seoul");
    expect(bySource.has("memory/preference:tone")).toBe(false);
  });

  it("is fail-open: a throwing user-memory source yields no chunks", async () => {
    const userMemorySource: UserMemoryKnowledgeSource = {
      facts: () => { throw new Error("memory store unreadable"); }
    };
    await expect(assembleKnowledgeCorpus({ userMemorySource })).resolves.toEqual([]);
  });
});

describe("knowledge_search spans episodes + user-memory (SB-1 unified recall)", () => {
  it("answers from a fact living ONLY in user-memory and cites memory/<key>, excluding a decoy", async () => {
    const userMemorySource: UserMemoryKnowledgeSource = {
      facts: () => [{ key: "blood_type", kind: "fact", value: "O-negative" }]
    };
    const tool = createNotesKnowledgeSearchTool({
      embed,
      userMemorySource,
      extraChunks: [{ source: "note/cat", text: "My cat is a tabby." }] // decoy
    });
    const result = String(await tool.execute({ query: "what is my blood type?" }, { runId: "r1" }));
    expect(result).toContain("[memory/fact:blood_type]");
    expect(result).toContain("O-negative");
    expect(result).not.toContain("tabby");
  });

  it("recalls an exact-keyword chunk pure cosine would drop (P23-2 hybrid wired into corpus search)", async () => {
    // The embed VOCAB has none of "tkt"/"5512", so the ticket chunk has
    // zero cosine — pure cosine would never surface it. Hybrid RRF
    // recalls it via the exact-token lexical overlap.
    const tool = createNotesKnowledgeSearchTool({
      embed,
      extraChunks: [
        { source: "note/decoy", text: "acme renewal planning notes" },
        { source: "note/ticket", text: "TKT-5512 is resolved and closed" }
      ],
      topK: 5
    });
    const result = String(await tool.execute({ query: "acme ticket TKT-5512" }, { runId: "r1" }));
    expect(result).toContain("[note/ticket]");
    expect(result).toContain("TKT-5512");
  });

  it("answers from a past session summary and cites episode/<when>", async () => {
    const episodesSource: EpisodesKnowledgeSource = {
      recentEpisodes: () => [{ id: "e1", summary: "Plan to handle the Acme renewal by Friday.", when: "2026-05-20" }]
    };
    const tool = createNotesKnowledgeSearchTool({ embed, episodesSource });
    const result = String(await tool.execute({ query: "what was the plan for the acme renewal?" }, { runId: "r1" }));
    expect(result).toContain("[episode/2026-05-20]");
    expect(result).toContain("Acme renewal");
  });
});
