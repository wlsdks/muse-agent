import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StoreBackedEpisodicRecallProvider } from "@muse/agent-core";
import { FileConversationSummaryStore } from "@muse/memory";
import { afterAll, describe, expect, it } from "vitest";

// End-to-end proof of CROSS-SESSION self-improvement on the fixed local model:
// an experience persisted in one CLI session must be RECALLED by a fresh process
// in the next — the whole point of file-backing the summary store (fires 19/21).
// Before that fix the CLI used an in-memory store that was empty every process,
// so this chain (persist → retrieve) silently did nothing. Deterministic: a stub
// embedder (no Ollama) gives the query a high cosine to the relevant narrative and
// zero to an unrelated one, so the assertion turns ONLY on persistence + recall.
const VOCAB = ["manager", "dana", "kim", "weekend", "hiking", "coast"] as const;
const stubEmbed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
};

describe("cross-session experience recall (self-improvement is real, not asserted)", () => {
  let dirs: string[] = [];
  const freshFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "muse-xsession-"));
    dirs.push(dir);
    return join(dir, "conversation-summaries.json");
  };
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  it("an experience persisted in session 1 is recalled by a FRESH provider in session 2", async () => {
    const file = freshFile();

    // session 1 — a prior conversation taught Muse a fact, persisted to the file store
    await new FileConversationSummaryStore({ file }).save({
      sessionId: "s1", userId: "u1", narrative: "the user's manager is Dana Kim", facts: [], summarizedUpToIndex: 1
    });

    // session 2 — a NEW process: a fresh store on the same file + the real recall provider
    const provider = new StoreBackedEpisodicRecallProvider({
      store: new FileConversationSummaryStore({ file }),
      embed: stubEmbed,
      minScore: 0.1
    });
    const snap = await provider.resolve("who is my manager", "u1");
    expect(snap?.matches.some((m) => m.narrative.includes("Dana Kim"))).toBe(true); // cross-session benefit

    // a fresh user with an EMPTY store recalls nothing — the difference is ONLY the stored experience
    const emptyProvider = new StoreBackedEpisodicRecallProvider({
      store: new FileConversationSummaryStore({ file: freshFile() }),
      embed: stubEmbed,
      minScore: 0.1
    });
    const emptySnap = await emptyProvider.resolve("who is my manager", "u1");
    expect(emptySnap === undefined || emptySnap.matches.length === 0).toBe(true);
  });

  it("an UNRELATED query does not falsely recall the stored experience (no spurious grounding)", async () => {
    const file = freshFile();
    await new FileConversationSummaryStore({ file }).save({
      sessionId: "s1", userId: "u1", narrative: "the user's manager is Dana Kim", facts: [], summarizedUpToIndex: 1
    });
    const provider = new StoreBackedEpisodicRecallProvider({
      store: new FileConversationSummaryStore({ file }),
      embed: stubEmbed,
      minScore: 0.1
    });
    const snap = await provider.resolve("plan a weekend hiking coast trip", "u1");
    expect(snap === undefined || snap.matches.length === 0).toBe(true);
  });
});
