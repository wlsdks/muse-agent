import { describe, expect, it } from "vitest";

import {
  EmbeddingEpisodicRecallProvider,
  InMemoryEpisodicRecallProvider,
  StoreBackedEpisodicRecallProvider,
  type StoredEpisode
} from "../src/index.js";

/**
 * P0-b2 (recall half): embedding-similarity recall must retrieve a
 * memory from a PARAPHRASE that shares no tokens with the stored
 * narrative — the case Jaccard token-overlap structurally misses.
 *
 * Deterministic concept-embedder (no network): a vector over
 * [drink, morning, travel]; paraphrase words map to the same
 * concept dim as the narrative's words, so cosine is high even with
 * zero literal token overlap.
 */
const CONCEPTS: Record<string, readonly string[]> = {
  drink: ["espresso", "caffeinated", "beverage", "drink", "coffee", "roast"],
  morning: ["sunrise", "breakfast", "morning", "dawn"],
  travel: ["passport", "trip", "renew", "travel", "flight"]
};

function conceptEmbed(text: string): Promise<readonly number[]> {
  const lower = text.toLowerCase();
  const vec = (Object.keys(CONCEPTS) as (keyof typeof CONCEPTS)[]).map((concept) =>
    CONCEPTS[concept]!.reduce((n, word) => (lower.includes(word) ? n + 1 : n), 0)
  );
  return Promise.resolve(vec);
}

const episodes: readonly StoredEpisode[] = [
  { narrative: "favourite hot drink is dark roast brewed espresso each sunrise", sessionId: "coffee" },
  { narrative: "reminded to renew the passport before the trip", sessionId: "passport" }
];

const PARAPHRASE = "which caffeinated beverage do I enjoy at breakfast";

describe("P0-b2 — embedding-similarity episodic recall (paraphrase)", () => {
  it("retrieves the right memory from a zero-token-overlap paraphrase", async () => {
    const provider = new EmbeddingEpisodicRecallProvider({
      embed: conceptEmbed,
      episodes,
      recencyWeight: 0
    });
    const snapshot = await provider.resolve(PARAPHRASE);
    expect(snapshot?.matches[0]?.sessionId).toBe("coffee");
  });

  it("Jaccard token-overlap structurally MISSES the same paraphrase (the gap this closes)", () => {
    const jaccard = new InMemoryEpisodicRecallProvider({ episodes, recencyWeight: 0 });
    // No shared tokens between PARAPHRASE and either narrative →
    // Jaccard score 0 < minScore → nothing recalled.
    expect(jaccard.resolve(PARAPHRASE)).toBeUndefined();
  });

  it("does not surface an unrelated memory (decoy stays below threshold)", async () => {
    const provider = new EmbeddingEpisodicRecallProvider({
      embed: conceptEmbed,
      episodes,
      recencyWeight: 0
    });
    const snapshot = await provider.resolve("when does my passport expire for the flight");
    expect(snapshot?.matches[0]?.sessionId).toBe("passport");
  });
});

describe("P0-b2 — production StoreBackedEpisodicRecallProvider embedding path", () => {
  const store = {
    listAll: () =>
      episodes.map((e) => ({ narrative: e.narrative, sessionId: e.sessionId }))
  };

  it("uses embedding cosine when an embedder is wired — paraphrase recalls", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({
      embed: conceptEmbed,
      recencyWeight: 0,
      store
    });
    const snapshot = await provider.resolve(PARAPHRASE);
    expect(snapshot?.matches[0]?.sessionId).toBe("coffee");
  });

  it("fail-open: a throwing embedder degrades to Jaccard, never breaks recall", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({
      embed: () => Promise.reject(new Error("ollama down")),
      recencyWeight: 0,
      store
    });
    // Jaccard still works for a token-overlapping query (no crash).
    const snapshot = await provider.resolve("renew the passport before the trip");
    expect(snapshot?.matches[0]?.sessionId).toBe("passport");
  });

  it("no embedder → Jaccard (back-compat, paraphrase still misses)", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({ recencyWeight: 0, store });
    expect(await provider.resolve(PARAPHRASE)).toBeUndefined();
  });
});
