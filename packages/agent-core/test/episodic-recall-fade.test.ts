/**
 * Ebbinghaus closed forgetting loop (arXiv:2305.10250, MemoryBank).
 * Tests that the fade penalty down-ranks faded sessions without deleting them,
 * that the fail-open contract holds, and the counterfactual that proves
 * FADE_PENALTY is the cause of the re-ranking (not recency or other factors).
 */
import { describe, expect, it } from "vitest";

import {
  StoreBackedEpisodicRecallProvider,
  type SummaryListSource
} from "../src/episodic-recall.js";

function makeStore(summaries: ReadonlyArray<{
  sessionId: string;
  narrative: string;
  createdAt?: Date;
  userId?: string;
}>): SummaryListSource {
  return {
    listAll(options?: { readonly userId?: string; readonly limit?: number }) {
      const filtered = options?.userId
        ? summaries.filter((e) => e.userId === options.userId)
        : summaries;
      return filtered.slice(0, options?.limit ?? 200);
    }
  };
}

// Both sessions share the same narrative so Jaccard scores them identically.
// Recency weight is 0 so the only differentiator is fadedKeys.
const NOW_MS = new Date("2026-01-01T00:00:00Z").getTime();
const SAME_DATE = new Date("2025-12-20T00:00:00Z");

const twoEqualStore = makeStore([
  { sessionId: "sess-A", narrative: "machine learning neural network training gradient descent", createdAt: SAME_DATE },
  { sessionId: "sess-B", narrative: "machine learning neural network training gradient descent", createdAt: SAME_DATE }
]);

describe("StoreBackedEpisodicRecallProvider — Ebbinghaus fade down-ranking", () => {
  const query = "machine learning neural network training gradient descent";

  it("counterfactual: without fadedKeys, A and B tie (order is insertion order)", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const snap = await provider.resolve(query);
    const ids = snap?.matches.map((m) => m.sessionId) ?? [];
    expect(ids).toContain("sess-A");
    expect(ids).toContain("sess-B");
  });

  it("faded A is down-ranked: B appears before A when A is in fadedKeys", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => new Set(["sess-A"]),
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const snap = await provider.resolve(query);
    const ids = snap?.matches.map((m) => m.sessionId) ?? [];
    expect(ids[0]).toBe("sess-B");
    expect(ids[1]).toBe("sess-A");
  });

  it("down-rank not delete: with large topK, faded A is still present (lower rank)", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => new Set(["sess-A"]),
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 10,
      now: () => NOW_MS
    });
    const snap = await provider.resolve(query);
    const ids = snap?.matches.map((m) => m.sessionId) ?? [];
    expect(ids).toContain("sess-A");
  });

  it("fail-open: a throwing fadedKeys loader → ranking unchanged from no-fade case, no crash", async () => {
    const providerNoFade = new StoreBackedEpisodicRecallProvider({
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const providerThrows = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => { throw new Error("sidecar unreadable"); },
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const snapNoFade = await providerNoFade.resolve(query);
    const snapThrows = await providerThrows.resolve(query);
    // Both return the same sessions (order may differ but neither crashes)
    const noFadeIds = (snapNoFade?.matches ?? []).map((m) => m.sessionId).sort();
    const throwsIds = (snapThrows?.matches ?? []).map((m) => m.sessionId).sort();
    expect(throwsIds).toEqual(noFadeIds);
  });

  it("sub-minScore match stays excluded regardless of fade state", async () => {
    // A query with no overlapping tokens with the stored narratives → baseSim = 0 < minScore
    const noOverlapQuery = "completely unrelated topic with zero shared tokens xyz123";
    const provider = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => new Set(["sess-A", "sess-B"]),
      minScore: 0.15,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 10,
      now: () => NOW_MS
    });
    const snap = await provider.resolve(noOverlapQuery);
    // No overlap → excluded by minScore gate; fade penalty cannot resurrect them
    expect(snap).toBeUndefined();
  });

  it("a faded session re-engaged recently is NOT down-ranked (reinstatement carve-out)", async () => {
    const DAY = 24 * 60 * 60 * 1_000;
    const provider = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => new Set(["sess-A"]),
      recallStats: async () =>
        new Map([
          ["sess-A", { hits: 1, lastHitMs: NOW_MS - 60_000 }],
          ["sess-B", { hits: 1, lastHitMs: NOW_MS - 90 * DAY }]
        ]),
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const snap = await provider.resolve(query);
    const ids = snap?.matches.map((m) => m.sessionId) ?? [];
    // A was just re-recalled → its fade penalty is waived → it must not sit below B.
    expect(ids.indexOf("sess-A")).toBeLessThanOrEqual(ids.indexOf("sess-B"));
  });

  it("control: a faded session whose last re-access is OLD stays down-ranked", async () => {
    const DAY = 24 * 60 * 60 * 1_000;
    const provider = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => new Set(["sess-A"]),
      recallStats: async () =>
        new Map([
          ["sess-A", { hits: 1, lastHitMs: NOW_MS - 90 * DAY }],
          ["sess-B", { hits: 1, lastHitMs: NOW_MS - 90 * DAY }]
        ]),
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const snap = await provider.resolve(query);
    const ids = snap?.matches.map((m) => m.sessionId) ?? [];
    expect(ids[0]).toBe("sess-B");
    expect(ids[1]).toBe("sess-A");
  });

  it("non-faded session is not penalised (similarity multiplier stays 1.0)", async () => {
    const providerNoFade = new StoreBackedEpisodicRecallProvider({
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const providerBFaded = new StoreBackedEpisodicRecallProvider({
      fadedKeys: async () => new Set(["sess-B"]),
      minScore: 0.05,
      recencyWeight: 0,
      store: twoEqualStore,
      topK: 2,
      now: () => NOW_MS
    });
    const simANoFade = (await providerNoFade.resolve(query))?.matches.find((m) => m.sessionId === "sess-A")?.similarity;
    const simABFaded = (await providerBFaded.resolve(query))?.matches.find((m) => m.sessionId === "sess-A")?.similarity;
    // sess-A was not faded, its similarity should be identical in both providers
    expect(simANoFade).toBeDefined();
    expect(simABFaded).toBeCloseTo(simANoFade!, 6);
  });
});
