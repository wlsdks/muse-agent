import { createHistorySearchTool } from "@muse/recall";
import type { NotesContent, NotesEntry, NotesProvider } from "@muse/domain-tools";
import type { UserMemory, UserMemoryStore } from "@muse/memory";
import { describe, expect, it } from "vitest";

import { buildHistoryRecords, type EpisodeRecord } from "../src/history-records-provider.js";

const USER = "user-1";
const ctx = { runId: "test-run" };

function fakeNotesProvider(notes: readonly { id: string; title: string; body: string; updatedAt?: Date }[]): NotesProvider {
  const byId = new Map(notes.map((n) => [n.id, n]));
  return {
    id: "fake",
    describe: () => ({ id: "fake", displayName: "Fake", description: "", local: true }),
    list: async (): Promise<readonly NotesEntry[]> =>
      notes.map((n) => ({ id: n.id, providerId: "fake", title: n.title, ...(n.updatedAt ? { updatedAt: n.updatedAt } : {}) })),
    read: async (id): Promise<NotesContent | undefined> => {
      const n = byId.get(id);
      return n ? { id: n.id, providerId: "fake", title: n.title, body: n.body } : undefined;
    },
    search: async () => [],
    save: async () => {
      throw new Error("not used");
    },
    append: async () => {
      throw new Error("not used");
    }
  };
}

function fakeMemoryStore(memory: Partial<UserMemory> | undefined): UserMemoryStore {
  return {
    findByUserId: async (userId): Promise<UserMemory | undefined> => {
      if (userId !== USER || !memory) {
        return undefined;
      }
      return { userId: USER, facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(0), ...memory };
    }
  } as unknown as UserMemoryStore;
}

const episodes: readonly EpisodeRecord[] = [
  { id: "ep-1", userId: USER, summary: "We debugged the VPN MTU packet drops on the work laptop.", endedAt: "2026-01-01T00:00:00.000Z" },
  { id: "ep-other", userId: "someone-else", summary: "VPN MTU notes for a different user.", endedAt: "2026-01-02T00:00:00.000Z" }
];

describe("buildHistoryRecords — all three advertised sources are really searched (A1)", () => {
  it("returns a real NOTE as a hit labelled [notes:...] end-to-end through the tool", async () => {
    const tool = createHistorySearchTool({
      records: () =>
        buildHistoryRecords({
          readEpisodes: () => episodes,
          notesProvider: fakeNotesProvider([
            { id: "note-1", title: "Sourdough", body: "My sourdough starter feeding schedule and hydration ratio." }
          ]),
          userMemoryStore: fakeMemoryStore({ facts: {} }),
          userId: USER
        })
    });
    const out = await tool.execute({ query: "sourdough starter hydration" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("[notes:note-1]");
    expect(text).toContain("sourdough");
  });

  it("returns a real remembered FACT as a hit labelled [memory:...] end-to-end through the tool", async () => {
    const tool = createHistorySearchTool({
      records: () =>
        buildHistoryRecords({
          readEpisodes: () => episodes,
          userMemoryStore: fakeMemoryStore({ facts: { allergy: "allergic to shellfish and peanuts" } }),
          userId: USER
        })
    });
    const out = await tool.execute({ query: "shellfish allergy" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("[memory:fact:allergy]");
    expect(text).toContain("shellfish");
  });

  it("returns a real PREFERENCE as a memory hit", async () => {
    const records = await buildHistoryRecords({
      readEpisodes: () => episodes,
      userMemoryStore: fakeMemoryStore({ preferences: { tone: "prefers concise terse answers" } }),
      userId: USER
    });
    const pref = records.find((r) => r.ref === "preference:tone");
    expect(pref).toBeDefined();
    expect(pref!.source).toBe("memory");
    expect(pref!.text).toContain("concise");
  });

  it("merges episodes + notes + memory and scopes episodes to the user", async () => {
    const records = await buildHistoryRecords({
      readEpisodes: () => episodes,
      notesProvider: fakeNotesProvider([{ id: "note-1", title: "T", body: "body" }]),
      userMemoryStore: fakeMemoryStore({ facts: { k: "v" } }),
      userId: USER
    });
    const sources = records.map((r) => r.source).sort();
    expect(sources).toEqual(["episodes", "memory", "notes"]);
    expect(records.some((r) => r.ref === "ep-other")).toBe(false);
  });

  it("is per-source fail-soft: a throwing notes provider still returns episodes + memory", async () => {
    const throwingNotes = { ...fakeNotesProvider([]), list: async () => { throw new Error("notes down"); } } as NotesProvider;
    const records = await buildHistoryRecords({
      readEpisodes: () => episodes,
      notesProvider: throwingNotes,
      userMemoryStore: fakeMemoryStore({ facts: { k: "v" } }),
      userId: USER
    });
    expect(records.some((r) => r.source === "episodes")).toBe(true);
    expect(records.some((r) => r.source === "memory")).toBe(true);
    expect(records.some((r) => r.source === "notes")).toBe(false);
  });

  it("omits a source cleanly when its reader is not configured (notes/memory absent)", async () => {
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: USER });
    expect(records.every((r) => r.source === "episodes")).toBe(true);
    expect(records).toHaveLength(1);
  });
});
