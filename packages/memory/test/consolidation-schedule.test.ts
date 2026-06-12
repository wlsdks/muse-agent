import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONSOLIDATION_MIN_INTERVAL_MS,
  DEFAULT_CONSOLIDATION_MIN_NEW_HITS,
  shouldConsolidateMemory
} from "../src/index.js";

const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const hoursMs = (h: number): number => h * 60 * 60_000;

describe("shouldConsolidateMemory", () => {
  it("never-run (lastRunMs undefined) + enough hits → true", () => {
    expect(shouldConsolidateMemory({ nowMs: NOW, lastRunMs: undefined, newHitsSinceLastRun: 5 })).toBe(true);
  });

  it("never-run + too few hits → false (material brake)", () => {
    expect(shouldConsolidateMemory({ nowMs: NOW, lastRunMs: undefined, newHitsSinceLastRun: 1 })).toBe(false);
  });

  it("recently run (1h ago, default 6h interval) + plenty of hits → false (time brake)", () => {
    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - hoursMs(1),
        newHitsSinceLastRun: 10
      })
    ).toBe(false);
  });

  it("long-ago run (7h ago, default 6h) + enough hits → true", () => {
    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - hoursMs(7),
        newHitsSinceLastRun: 5
      })
    ).toBe(true);
  });

  it("long-ago run + too few hits → false", () => {
    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - hoursMs(7),
        newHitsSinceLastRun: 1
      })
    ).toBe(false);
  });

  it("boundary: elapsed EXACTLY minIntervalMs + hits EXACTLY minNewHits → true (≥ on both)", () => {
    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - DEFAULT_CONSOLIDATION_MIN_INTERVAL_MS,
        newHitsSinceLastRun: DEFAULT_CONSOLIDATION_MIN_NEW_HITS
      })
    ).toBe(true);
  });

  it("non-finite nowMs → false", () => {
    expect(shouldConsolidateMemory({ nowMs: NaN, lastRunMs: NOW - hoursMs(7), newHitsSinceLastRun: 5 })).toBe(false);
    expect(shouldConsolidateMemory({ nowMs: Infinity, lastRunMs: NOW - hoursMs(7), newHitsSinceLastRun: 5 })).toBe(false);
  });

  it("non-finite newHits treated as 0 → false (below minimum)", () => {
    expect(shouldConsolidateMemory({ nowMs: NOW, lastRunMs: undefined, newHitsSinceLastRun: NaN })).toBe(false);
  });

  it("non-finite lastRunMs (NaN) with enough material → true (treated as never-run)", () => {
    expect(shouldConsolidateMemory({ nowMs: NOW, lastRunMs: NaN, newHitsSinceLastRun: 5 })).toBe(true);
  });

  it("custom minIntervalMs and minNewHits are honored", () => {
    const customInterval = hoursMs(2);
    const customMinHits = 1;

    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - hoursMs(1),
        newHitsSinceLastRun: 1,
        minIntervalMs: customInterval,
        minNewHits: customMinHits
      })
    ).toBe(false);

    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - hoursMs(3),
        newHitsSinceLastRun: 1,
        minIntervalMs: customInterval,
        minNewHits: customMinHits
      })
    ).toBe(true);

    expect(
      shouldConsolidateMemory({
        nowMs: NOW,
        lastRunMs: NOW - hoursMs(3),
        newHitsSinceLastRun: 0,
        minIntervalMs: customInterval,
        minNewHits: customMinHits
      })
    ).toBe(false);
  });
});
