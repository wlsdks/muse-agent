import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UserMemory, UserMemoryStore } from "@muse/memory";
import { writeEpisodes } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEpisodeKnowledgeEntries } from "../src/episodes-knowledge-source.js";
import { createNotesKnowledgeSearchTool } from "../src/knowledge-corpus.js";
import { createUserMemoryKnowledgeSource } from "../src/user-memory-knowledge-source.js";

// SB-1 composition proof: the REAL episode + user-memory adapters, plugged
// into knowledge_search exactly as createMuseRuntimeAssembly wires them, make
// a fact living ONLY in a past session or in remembered memory answerable +
// cited. The engine test uses fake sources and the adapters are unit-tested
// in isolation; this proves they compose end-to-end at the tool surface.

const VOCAB = ["blood", "negative", "quokka", "subway", "tabby"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

const userMemory = (userId: string): UserMemory => ({
  facts: { blood_type: "O-negative" },
  preferences: {},
  recentTopics: [],
  updatedAt: new Date("2026-05-22T00:00:00Z"),
  userId
});
const memoryStore = (forUser: string): UserMemoryStore =>
  ({ findByUserId: async (id: string) => (id === forUser ? userMemory(forUser) : undefined) } as unknown as UserMemoryStore);

let dir: string;
let episodesFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-sb1-"));
  episodesFile = join(dir, "episodes.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("SB-1 unified recall — real adapters compose into knowledge_search", () => {
  it("answers from a PAST SESSION (episode store) and cites episode/<date>", async () => {
    await writeEpisodes(episodesFile, [
      { endedAt: "2026-05-22T10:00:00Z", id: "ep1", startedAt: "2026-05-22T09:00:00Z", summary: "We discussed the quokka subway project.", userId: "user" }
    ]);
    const tool = createNotesKnowledgeSearchTool({
      embed,
      episodesSource: { recentEpisodes: (limit) => readEpisodeKnowledgeEntries(episodesFile, "user", limit) }
    });
    const result = String(await tool.execute({ query: "what did we discuss about the quokka subway?" }, { runId: "r1" }));
    expect(result).toContain("[episode/2026-05-22]");
    expect(result).toContain("quokka subway");
  });

  it("answers from REMEMBERED MEMORY (user-memory store) and cites memory/<key>", async () => {
    const tool = createNotesKnowledgeSearchTool({
      embed,
      userMemorySource: createUserMemoryKnowledgeSource(memoryStore("user"), "user"),
      extraChunks: [{ source: "note/cat", text: "My cat is a tabby." }] // decoy
    });
    const result = String(await tool.execute({ query: "what is my blood type?" }, { runId: "r1" }));
    expect(result).toContain("[memory/fact:blood_type]");
    expect(result).toContain("O-negative");
    expect(result).not.toContain("tabby");
  });

  it("scopes to the runtime user — another user's stores do not leak in", async () => {
    await writeEpisodes(episodesFile, [
      { endedAt: "2026-05-22T10:00:00Z", id: "ep1", startedAt: "2026-05-22T09:00:00Z", summary: "Quokka subway session for someone else.", userId: "other" }
    ]);
    const tool = createNotesKnowledgeSearchTool({
      embed,
      episodesSource: { recentEpisodes: (limit) => readEpisodeKnowledgeEntries(episodesFile, "user", limit) },
      userMemorySource: createUserMemoryKnowledgeSource(memoryStore("someone-else"), "user")
    });
    const result = String(await tool.execute({ query: "what is my blood type or the quokka subway?" }, { runId: "r1" }));
    expect(result).not.toContain("[episode/");
    expect(result).not.toContain("[memory/");
  });
});
