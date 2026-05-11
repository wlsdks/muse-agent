/**
 * D7 verification — `createUserMemoryAutoExtractHook` runs
 * `afterComplete`. The fact / preference it writes lands in
 * `UserMemoryStore`. The next agent run's `applyUserMemory` reads
 * the store fresh (no in-process cache), so newly-learned facts
 * surface in the very next turn's `[User Memory]` block. This test
 * pins that flow so a future cache layer can't silently make
 * fresh-fact lookup stale.
 */

import { describe, expect, it } from "vitest";

import { InMemoryUserMemoryStore } from "@muse/memory";

import { applyUserMemory } from "../src/context-transforms.js";

describe("user memory hot-refresh after upsert (D7)", () => {
  it("fact written between two applyUserMemory calls shows up in the second call", async () => {
    const store = new InMemoryUserMemoryStore();

    const context1 = {
      input: {
        messages: [{ content: "hi", role: "user" as const }],
        metadata: { userId: "stark" }
      },
      runId: "r-1",
      startedAt: new Date()
    };

    // First call — store is empty, no [User Memory] block injected.
    const first = await applyUserMemory(context1, store, 5);
    const firstSystem = first.messages.find((m) => m.role === "system")?.content ?? "";
    expect(firstSystem).not.toContain("[User Memory]");

    // afterComplete-style write: simulate the auto-extract hook
    // persisting a fact between the two turns.
    await store.upsertFact("stark", "favorite_db", "Kysely");

    const context2 = {
      input: {
        messages: [{ content: "what was my DB choice?", role: "user" as const }],
        metadata: { userId: "stark" }
      },
      runId: "r-2",
      startedAt: new Date()
    };

    const second = await applyUserMemory(context2, store, 5);
    const secondSystem = second.messages.find((m) => m.role === "system")?.content ?? "";
    expect(secondSystem).toContain("[User Memory]");
    expect(secondSystem).toContain("favorite_db: Kysely");
  });
});
