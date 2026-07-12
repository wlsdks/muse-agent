/**
 * contract test: an autonomous memory-consolidation tick must NEVER
 * delete a user-directed fact. `selectForgettable`/`consolidationPlan` are
 * already non-destructive (fade only down-ranks recall), and the one
 * autonomous `store.forget` call (inside `promoteRecalledMemories`) is
 * namespace-scoped to `recalled-*` (Muse's own synthetic persona facts) — but
 * nothing pinned that end-to-end before this test. This wires the SAME real
 * composition `daemon-selflearn-ticks.ts`'s `makeMemoryConsolidateTick` uses
 * (`persist` → `promoteRecalledMemories`, `persistFade` → `writeFadedMemoryKeys`)
 * against REAL temp-file-backed stores — not mocks — so it proves the actual
 * production path, not a stand-in for it. (Using a real store also surfaced
 * that `FileUserMemoryStore` normalizes "-" to "_" on write, so the ACTUAL
 * persisted namespace is `recalled_*`, not the literal `PROMOTED_FACT_PREFIX`
 * — a mocked store that stores keys verbatim would never have caught this.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileUserMemoryStore } from "@muse/memory";
import { readFadedMemoryKeys, readRecallHits, recordRecallHits, writeFadedMemoryKeys } from "@muse/stores";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { promoteRecalledMemories } from "./commands-memory.js";
import { runMemoryConsolidationTick, type MemoryConsolidationTickDeps } from "./memory-consolidate-tick.js";

const DAY_MS = 24 * 60 * 60_000;
const USER_ID = "user-fact-protection-test";

let dir: string;
let memoryFile: string;
let hitsFile: string;
let fadeFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-memory-user-fact-protection-"));
  memoryFile = join(dir, "user-memory.json");
  hitsFile = join(dir, "recall-hits.json");
  fadeFile = join(dir, "memory-fade.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

/**
 * Seed enough real recall-hit material that BOTH promote and fade actually
 * fire on the tick that follows — a tick that no-ops would trivially "protect"
 * the user fact, which would prove nothing (the vacuous-pass trap).
 */
async function seedNonVacuousRecallMaterial(nowMs: number): Promise<void> {
  // Promotable: 5 hits spaced across 5 distinct calendar days (24h apart),
  // all recent — clears the default minHits(3) / minScore(0.5) /
  // minDistinctAccessDays(2) gates in selectPromotableMemories.
  for (let i = 0; i < 5; i += 1) {
    await recordRecallHits(
      hitsFile,
      [{ key: "mem-favorite-coffee", summary: "User's favorite coffee shop is Blue Bottle" }],
      nowMs - i * DAY_MS
    );
  }
  // Fade-eligible: 1 hit, last touched 300 days ago — well past the default
  // maxScore(0.25) / minAgeDays(30) fade floor in selectForgettable.
  await recordRecallHits(hitsFile, [{ key: "stale-session" }], nowMs - 300 * DAY_MS);
}

function makeDeps(nowMs: number, logs: string[]): MemoryConsolidationTickDeps {
  const store = new FileUserMemoryStore({ file: memoryFile });
  return {
    enabled: true,
    lastRunMs: undefined,
    log: (line) => logs.push(line),
    minIntervalMs: 1,
    minNewHits: 1,
    nowMs,
    readHits: () => readRecallHits(hitsFile),
    persist: async () => {
      const result = await promoteRecalledMemories({
        store,
        userId: USER_ID,
        readHits: () => readRecallHits(hitsFile)
      });
      return { promoted: result.promoted.length };
    },
    persistFade: (fadeKeys) => writeFadedMemoryKeys(fadeFile, fadeKeys, Date.now())
  };
}

describe("— autonomous memory consolidation never deletes a user-directed fact", () => {
  it("a user fact survives a real, non-vacuous consolidation tick (promote AND fade both fire)", async () => {
    const store = new FileUserMemoryStore({ file: memoryFile });
    await store.upsertFact(USER_ID, "home_city", "Seoul");
    await store.upsertFact(USER_ID, "favorite_food", "Kimchi");

    const nowMs = Date.now();
    await seedNonVacuousRecallMaterial(nowMs);

    const logs: string[] = [];
    const state = await runMemoryConsolidationTick(makeDeps(nowMs, logs));

    // Non-vacuous: the tick actually ran and did real promote + fade work —
    // if this fails the survival assertions below would be worthless.
    expect(state.lastRunMs).toBe(nowMs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/consolidate-memory:/);
    const promotedCount = Number(/(\d+) promoted/.exec(logs[0] ?? "")?.[1]);
    const fadingCount = Number(/(\d+) fading/.exec(logs[0] ?? "")?.[1]);
    expect(promotedCount).toBeGreaterThan(0);
    expect(fadingCount).toBeGreaterThan(0);
    expect((await readFadedMemoryKeys(fadeFile)).has("stale-session")).toBe(true);

    // Promotion actually wrote its own `recalled-*` facts (proves the
    // persist path really ran, not just logged a plan). NOTE: the store
    // normalizes keys (normalizeMemoryKey folds "-" to "_"), so the
    // PERSISTED form is `recalled_N`, not the literal `PROMOTED_FACT_PREFIX`
    // ("recalled-") — checked against the real stored key, not the raw one.
    const after = await store.findByUserId(USER_ID);
    const recalledKeys = Object.keys(after?.facts ?? {}).filter((k) => k.startsWith("recalled_"));
    expect(recalledKeys.length).toBeGreaterThan(0);

    // THE CONTRACT: both user-directed facts survive, unchanged, byte-for-byte.
    expect(after?.facts.home_city).toBe("Seoul");
    expect(after?.facts.favorite_food).toBe("Kimchi");
  });

  it("a stale recalled-* fact coexists with a user fact — whatever happens to the recalled-* namespace, the user fact is never touched", async () => {
    const store = new FileUserMemoryStore({ file: memoryFile });
    await store.upsertFact(USER_ID, "home_city", "Seoul");
    // A stale promoted fact from a hypothetical prior run — this is the ONLY
    // namespace the autonomous cleanup in promoteRecalledMemories may touch.
    // (Not asserting it gets cleared here: the cleanup's `startsWith` check
    // compares against the un-normalized "recalled-" literal while the store
    // normalizes "-" to "_" on write — a separate, pre-existing accumulation
    // bug in promoteRecalledMemories that is orthogonal to THIS contract. The
    // boundary this test pins is narrower and still holds regardless: the
    // cleanup never crosses into the user's own fact.)
    await store.upsertFact(USER_ID, "recalled-0", "a stale promoted summary from a prior run");

    const nowMs = Date.now();
    await seedNonVacuousRecallMaterial(nowMs);

    const logs: string[] = [];
    await runMemoryConsolidationTick(makeDeps(nowMs, logs));

    const after = await store.findByUserId(USER_ID);
    // THE CONTRACT: the user fact is untouched no matter what the autonomous
    // cleanup does to its own recalled_* namespace.
    expect(after?.facts.home_city).toBe("Seoul");
    // No key in the store carries the user's fact VALUE under a different
    // key — the cleanup never aliases/duplicates user data either.
    for (const [key, value] of Object.entries(after?.facts ?? {})) {
      if (key !== "home_city") expect(value).not.toBe("Seoul");
    }
  });
});
