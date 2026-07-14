import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRecallHits } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { recordFactRecallHits } from "../src/context-engineering-builders.js";
import {
  assembleKnowledgeCorpus,
  createNotesKnowledgeSearchTool,
  parseMemoryFactKey,
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

describe("parseMemoryFactKey — recover the fact key from a memory/-sourced chunk label", () => {
  it("strips the memory/ prefix and a leading fact:/preference: kind tag; ignores non-memory sources", () => {
    expect(parseMemoryFactKey("memory/fact:blood_type")).toBe("blood_type");
    expect(parseMemoryFactKey("memory/preference:tone")).toBe("tone");
    expect(parseMemoryFactKey("memory/city")).toBe("city"); // no kind tag
    expect(parseMemoryFactKey("note/cat")).toBeUndefined();
    expect(parseMemoryFactKey("episode/2026-05-20")).toBeUndefined();
    expect(parseMemoryFactKey("memory/")).toBeUndefined();
  });
});

describe("fact-recall recording — surfaced-into-results, SEPARATE ledger, fail-soft (T1-b-i)", () => {
  let dir: string;
  let factFile: string;
  let episodeFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-fact-recall-"));
    factFile = join(dir, "fact-recall-hits.json");
    episodeFile = join(dir, "recall-hits.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function waitForFactHits(expected: number): Promise<Awaited<ReturnType<typeof readRecallHits>>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const hits = await readRecallHits(factFile);
      if (hits.length >= expected) return hits;
      await sleep(10);
    }
    return readRecallHits(factFile);
  }

  it("records exactly one fact-recall hit for a memory-sourced chunk that passed ranking, into the SEPARATE fact file (never the episode one)", async () => {
    const userMemorySource: UserMemoryKnowledgeSource = {
      facts: () => [{ key: "blood_type", kind: "fact", value: "O-negative" }]
    };
    const tool = createNotesKnowledgeSearchTool({
      embed,
      userMemorySource,
      extraChunks: [{ source: "note/cat", text: "My cat is a tabby." }], // decoy — must NOT be recorded (not memory/)
      onFactRecall: (keys, query) => recordFactRecallHits(factFile, keys, query)
    });
    const result = String(await tool.execute({ query: "what is my blood type?" }, { runId: "r1" }));
    expect(result).toContain("[memory/fact:blood_type]");

    const hits = await waitForFactHits(1);
    expect(hits.map((h) => h.key)).toEqual(["blood_type"]);
    expect(hits[0]?.hits).toBe(1);
    expect(hits[0]?.queryHashes).toHaveLength(1); // one distinct query recorded
    // The SEPARATE-file invariant: the episode recall-hits ledger is untouched.
    await expect(stat(episodeFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records ZERO fact hits (file never created) when no memory chunk is in the results", async () => {
    const tool = createNotesKnowledgeSearchTool({
      embed,
      extraChunks: [{ source: "note/ticket", text: "acme renewal planning notes" }],
      onFactRecall: (keys, query) => recordFactRecallHits(factFile, keys, query)
    });
    const result = String(await tool.execute({ query: "acme renewal" }, { runId: "r1" }));
    expect(result).toContain("[note/ticket]");
    await sleep(40);
    await expect(stat(factFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is fail-soft: a throwing onFactRecall never breaks the returned recall results", async () => {
    const userMemorySource: UserMemoryKnowledgeSource = {
      facts: () => [{ key: "blood_type", kind: "fact", value: "O-negative" }]
    };
    const tool = createNotesKnowledgeSearchTool({
      embed,
      userMemorySource,
      onFactRecall: () => { throw new Error("recorder exploded"); }
    });
    const result = String(await tool.execute({ query: "what is my blood type?" }, { runId: "r1" }));
    expect(result).toContain("[memory/fact:blood_type]");
    expect(result).toContain("O-negative");
  });
});
