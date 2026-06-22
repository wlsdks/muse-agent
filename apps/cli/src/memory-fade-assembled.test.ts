/**
 * Assembled-path (non-inert) test for the Ebbinghaus closed forgetting loop
 * (arXiv:2305.10250, MemoryBank). Every byte flows through the shipped
 * write/read paths — NO hand-built fixture JSON.
 *
 * Flow: recordRecallHits (real) → consolidationPlan (real) → writeFadedMemoryKeys (real)
 *       → StoreBackedEpisodicRecallProvider with readFadedMemoryKeys (real)
 *       → resolve → B outranks A
 *
 * The session-key identity check is implicit: consolidate writes plan.fade[i].key
 * (which equals the recall-hit record key = sessionId), and the provider looks up
 * summary.sessionId in the faded set. A mismatch would silently produce no penalty
 * — this test catches that by asserting a concrete rank order.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StoreBackedEpisodicRecallProvider } from "@muse/agent-core";
import { consolidationPlan } from "@muse/memory";
import { InMemoryConversationSummaryStore } from "@muse/memory";
import { readFadedMemoryKeys, readRecallHits, recordRecallHits, writeFadedMemoryKeys } from "@muse/stores";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let hitsFile: string;
let fadeFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-fade-assembled-"));
  hitsFile = join(dir, "recall-hits.json");
  fadeFile = join(dir, "memory-fade.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

// Identical narrative ensures Jaccard scores are equal — only the fade penalty
// can flip the order. recencyWeight = 0 removes the creation-time factor.
const SHARED_NARRATIVE = "typescript compiler options tsconfig strict mode build";
const QUERY = "typescript compiler options tsconfig strict mode build";

describe("assembled-path — Ebbinghaus closed loop through real write/read paths", () => {
  it("B outranks A after consolidate marks A as fading (key-identity proven end-to-end)", async () => {
    const sixtyDaysAgoMs = Date.now() - 60 * 24 * 60 * 60_000;

    // A: only an old hit (will satisfy minAgeDays ≥ 30).
    await recordRecallHits(hitsFile, [{ key: "sess-A", summary: SHARED_NARRATIVE }], sixtyDaysAgoMs - 5_000);
    // B: a recent hit (won't fade).
    await recordRecallHits(hitsFile, [{ key: "sess-B", summary: SHARED_NARRATIVE }], Date.now() - 1_000);

    // Real consolidation — maxScore high enough that A qualifies as fading.
    const records = await readRecallHits(hitsFile);
    const nowMs = Date.now();
    const plan = consolidationPlan(
      records.map((r) => ({ hits: r.hits, key: r.key, lastHitMs: r.lastHitMs, recentAccessMs: r.recentAccessMs })),
      { nowMs, minAgeDays: 30, maxScore: 0.99 }
    );
    expect(plan.fade.map((f) => f.key)).toContain("sess-A");

    // Real sidecar write.
    await writeFadedMemoryKeys(fadeFile, plan.fade.map((f) => f.key), nowMs);

    // Real summary store — sessionId matches the recall-hit key.
    const summaryStore = new InMemoryConversationSummaryStore();
    await summaryStore.save({ narrative: SHARED_NARRATIVE, sessionId: "sess-A", summarizedUpToIndex: 1 });
    await summaryStore.save({ narrative: SHARED_NARRATIVE, sessionId: "sess-B", summarizedUpToIndex: 1 });

    // Real provider with real fadedKeys loader.
    const provider = new StoreBackedEpisodicRecallProvider({
      fadedKeys: () => readFadedMemoryKeys(fadeFile),
      minScore: 0.05,
      recencyWeight: 0,
      store: summaryStore,
      topK: 2,
      now: () => nowMs
    });

    const snap = await provider.resolve(QUERY);
    const ids = snap?.matches.map((m) => m.sessionId) ?? [];
    expect(ids[0]).toBe("sess-B");
    expect(ids[1]).toBe("sess-A");
  });

  it("reinstatement: after sess-A gets a recent hit, next consolidation omits it from the fade sidecar", async () => {
    const sixtyDaysAgoMs = Date.now() - 60 * 24 * 60 * 60_000;
    await recordRecallHits(hitsFile, [{ key: "sess-A" }], sixtyDaysAgoMs - 5_000);

    let records = await readRecallHits(hitsFile);
    let plan = consolidationPlan(
      records.map((r) => ({ hits: r.hits, key: r.key, lastHitMs: r.lastHitMs, recentAccessMs: r.recentAccessMs })),
      { nowMs: Date.now(), minAgeDays: 30, maxScore: 0.99 }
    );
    expect(plan.fade.map((f) => f.key)).toContain("sess-A");
    await writeFadedMemoryKeys(fadeFile, plan.fade.map((f) => f.key), Date.now());
    expect((await readFadedMemoryKeys(fadeFile)).has("sess-A")).toBe(true);

    // Re-engage: recent recall hit.
    await recordRecallHits(hitsFile, [{ key: "sess-A" }], Date.now() - 500);

    // Second consolidation — A now has a recent hit so drops out of fade.
    records = await readRecallHits(hitsFile);
    const nowMs2 = Date.now();
    plan = consolidationPlan(
      records.map((r) => ({ hits: r.hits, key: r.key, lastHitMs: r.lastHitMs, recentAccessMs: r.recentAccessMs })),
      { nowMs: nowMs2, minAgeDays: 30, maxScore: 0.99 }
    );
    expect(plan.fade.map((f) => f.key)).not.toContain("sess-A");
    await writeFadedMemoryKeys(fadeFile, plan.fade.map((f) => f.key), nowMs2);

    // Sidecar no longer penalises sess-A.
    expect((await readFadedMemoryKeys(fadeFile)).has("sess-A")).toBe(false);
  });
});
