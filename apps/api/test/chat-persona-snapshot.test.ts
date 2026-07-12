import { describe, expect, it } from "vitest";

import type { UserMemory, UserMemoryStore } from "@muse/memory";

import { loadChatPersonaSnapshot } from "../src/chat-persona-snapshot.js";

function fakeStore(byUserId: Readonly<Record<string, UserMemory>>): UserMemoryStore {
  return {
    deleteByUserId: async () => true,
    findByUserId: async (userId: string) => byUserId[userId],
    upsertFact: async (userId: string) => {
      throw new Error(`unexpected upsertFact(${userId})`);
    },
    upsertPreference: async (userId: string) => {
      throw new Error(`unexpected upsertPreference(${userId})`);
    }
  };
}

const OWNER_MEMORY: UserMemory = {
  facts: { hobby: "climbing", language: "Korean", name: "진안" },
  preferences: { "goal:promo": "get promoted", "pref.tone": "casual", "veto:coffee": "no coffee talk" },
  recentTopics: ["Q1 budget", "trip planning"],
  updatedAt: new Date("2026-07-11T00:00:00.000Z"),
  userId: "telegram:owner-1"
};

describe("loadChatPersonaSnapshot", () => {
  it("scope discipline: a shared/group scope NEVER reads the store — returns null without querying it", async () => {
    let queried = false;
    const userMemoryStore: UserMemoryStore = {
      deleteByUserId: async () => true,
      findByUserId: async () => {
        queried = true;
        return OWNER_MEMORY;
      },
      upsertFact: async () => OWNER_MEMORY,
      upsertPreference: async () => OWNER_MEMORY
    };

    const snapshot = await loadChatPersonaSnapshot({
      providerId: "telegram",
      scope: "shared",
      source: "group-1",
      userMemoryStore
    });

    expect(snapshot).toBeNull();
    expect(queried).toBe(false);
  });

  it("owner (direct) scope returns a bounded, citable block — name/language first, vetoes/goals excluded", async () => {
    const userMemoryStore = fakeStore({ "telegram:owner-1": OWNER_MEMORY });

    const snapshot = await loadChatPersonaSnapshot({
      providerId: "telegram",
      scope: "direct",
      source: "owner-1",
      userMemoryStore
    });

    expect(snapshot).not.toBeNull();
    const lines = snapshot ?? [];
    // Every line carries a source id so it can be cited/checked as evidence.
    for (const line of lines) {
      expect(line.source.startsWith("persona:")).toBe(true);
      expect(line.text.length).toBeGreaterThan(0);
    }
    // name/language render first.
    expect(lines[0]?.text).toContain("name");
    expect(lines[1]?.text).toContain("language");
    // A veto/goal-prefixed preference is a behavioral guardrail, not smalltalk material.
    expect(lines.some((line) => line.text.includes("get promoted"))).toBe(false);
    expect(lines.some((line) => line.text.includes("no coffee talk"))).toBe(false);
    // A plain preference and a recent topic both make it in.
    expect(lines.some((line) => line.text.includes("casual"))).toBe(true);
    expect(lines.some((line) => line.text.includes("Q1 budget"))).toBe(true);
  });

  it("bounds the block to at most 10 lines even when memory holds far more", async () => {
    const manyFacts: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) manyFacts[`fact${String(i)}`] = `value${String(i)}`;
    const userMemoryStore = fakeStore({
      "telegram:owner-1": { ...OWNER_MEMORY, facts: manyFacts, preferences: {}, recentTopics: [] }
    });

    const snapshot = await loadChatPersonaSnapshot({
      providerId: "telegram",
      scope: "direct",
      source: "owner-1",
      userMemoryStore
    });

    expect(snapshot?.length).toBeLessThanOrEqual(10);
  });

  it("no memory yet for this owner scope → returns null (fail-open, not an empty stub)", async () => {
    const userMemoryStore = fakeStore({});

    const snapshot = await loadChatPersonaSnapshot({
      providerId: "telegram",
      scope: "direct",
      source: "owner-1",
      userMemoryStore
    });

    expect(snapshot).toBeNull();
  });

  it("no userMemoryStore provided → returns null", async () => {
    const snapshot = await loadChatPersonaSnapshot({
      providerId: "telegram",
      scope: "direct",
      source: "owner-1",
      userMemoryStore: undefined
    });

    expect(snapshot).toBeNull();
  });

  it("malformed store (findByUserId throws) → fails open to null, never throws", async () => {
    const userMemoryStore: UserMemoryStore = {
      deleteByUserId: async () => true,
      findByUserId: async () => {
        throw new Error("store is corrupted");
      },
      upsertFact: async () => {
        throw new Error("unused");
      },
      upsertPreference: async () => {
        throw new Error("unused");
      }
    };

    await expect(
      loadChatPersonaSnapshot({ providerId: "telegram", scope: "direct", source: "owner-1", userMemoryStore })
    ).resolves.toBeNull();
  });
});
