import { InMemoryUserMemoryStore } from "@muse/memory";
import { describe, expect, it } from "vitest";

import { applyUserMemory } from "../src/context-transforms.js";
import type { UserModelComposer } from "../src/types.js";

/**
 * The `userModelComposer` seam (user-model S1b): a supplied composer REPLACES
 * the built-in `renderUserMemorySection` for the "user-memory" section so a
 * shared learned-user-model layer (@muse/recall buildMusePersona, wired at the
 * assembly behind an opt-in flag) can reach every surface. Absent / declining
 * composer MUST be byte-identical to the default — this is the safety property
 * that makes the opt-in default a zero-regression change on the central path.
 */
async function sectionFor(composer?: UserModelComposer): Promise<string> {
  const store = new InMemoryUserMemoryStore();
  await store.upsertFact("stark", "favorite_db", "Kysely");
  const context = {
    input: { messages: [{ content: "hi", role: "user" as const }], metadata: { userId: "stark" } },
    runId: "r-1",
    startedAt: new Date()
  };
  const applied = await applyUserMemory(context, store, 5, composer);
  return applied.messages.find((m) => m.role === "system")?.content ?? "";
}

describe("applyUserMemory userModelComposer seam (S1b)", () => {
  it("no composer ⇒ the built-in section is used (byte-identical default)", async () => {
    const section = await sectionFor(undefined);
    expect(section).toContain("[User Memory]");
    expect(section).toContain("favorite_db: Kysely");
  });

  it("a composer REPLACES the built-in section with its own output", async () => {
    const seen: { userId?: string; max?: number; facts?: string[] } = {};
    const composer: UserModelComposer = (memory, userId, maxEntries) => {
      seen.userId = userId;
      seen.max = maxEntries;
      seen.facts = Object.keys(memory.facts);
      return "RICH-PERSONA-BLOCK for the owner";
    };
    const section = await sectionFor(composer);
    expect(section).toContain("RICH-PERSONA-BLOCK for the owner");
    // The default rendering must NOT also be present — one section, not two.
    expect(section).not.toContain("[User Memory]");
    // The composer got the run's own memory + userId (scope: per-userId, so a
    // channel identity would only ever see ITS memory, never the owner's).
    expect(seen).toEqual({ userId: "stark", max: 5, facts: ["favorite_db"] });
  });

  it("a composer that DECLINES (undefined) falls back to the built-in section", async () => {
    const section = await sectionFor(() => undefined);
    expect(section).toContain("[User Memory]");
    expect(section).toContain("favorite_db: Kysely");
  });
});
