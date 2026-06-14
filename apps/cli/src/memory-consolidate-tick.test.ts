import { describe, expect, it, vi } from "vitest";

import type { RecallHitLike } from "@muse/memory";

import { runMemoryConsolidationTick, type MemoryConsolidationTickDeps } from "./memory-consolidate-tick.js";

function makeHits(n: number, nowMs: number): readonly RecallHitLike[] {
  return Array.from({ length: n }, (_, i) => ({
    hits: 5,
    key: `mem-${i.toString()}`,
    lastHitMs: nowMs - i * 1000
  }));
}

const DAY_MS = 24 * 60 * 60_000;

// Fade-eligible fixture: low tally (1 hit) AND last hit ≥ 30 days ago → its
// recency-weighted score decays at/below the fade floor and ageDays ≥ minAge, so
// selectForgettable returns these keys. (makeHits above are all recent ⇒ 0 fading.)
function makeFadingHits(n: number, nowMs: number): readonly RecallHitLike[] {
  return Array.from({ length: n }, (_, i) => ({
    hits: 1,
    key: `stale-${i.toString()}`,
    lastHitMs: nowMs - (300 + i) * DAY_MS
  }));
}

// Fade-eligible fixture where last-hit RECENCY and ACT-R ACTIVATION disagree:
// 10 single-recent-access records (their last hit is recent-ish → highest recency
// score) + 1 SPACED record S (3 accesses, oldest last-hit → low recency score but
// HIGH ACT-R activation from frequency×spacing). With the default fade cap (10) and
// 11 eligible, the two rankings drop a DIFFERENT record: recency excludes r0 (most
// recent last hit) and keeps S; ACT-R excludes S (highest activation) and keeps r0.
function makeRecencyVsActrHits(nowMs: number): readonly RecallHitLike[] {
  const singles = Array.from({ length: 10 }, (_, i) => ({
    hits: 1,
    key: `r${i.toString()}`,
    lastHitMs: nowMs - (43 + i) * DAY_MS,
    recentAccessMs: [nowMs - (43 + i) * DAY_MS]
  }));
  const spaced = {
    hits: 3,
    key: "S",
    lastHitMs: nowMs - 90 * DAY_MS,
    recentAccessMs: [nowMs - 300 * DAY_MS, nowMs - 180 * DAY_MS, nowMs - 90 * DAY_MS]
  };
  return [...singles, spaced];
}

describe("runMemoryConsolidationTick", () => {
  it("enabled + brake passes — logs promote/fade counts and returns nextState with lastRunMs=nowMs", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: (line) => logs.push(line),
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(readHits).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/consolidate-memory:/);
    expect(logs[0]).toMatch(/promotable/);
    expect(logs[0]).toMatch(/fading/);
    expect(state.lastRunMs).toBe(nowMs);
  });

  it("disabled — readHits not called, log not called, state unchanged", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const prevLastRunMs = nowMs - 99_000;
    const deps: MemoryConsolidationTickDeps = {
      enabled: false,
      lastRunMs: prevLastRunMs,
      log: (line) => logs.push(line),
      nowMs,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(readHits).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
    expect(state.lastRunMs).toBe(prevLastRunMs);
  });

  it("enabled but brake fails (ran too recently) — log not called, state unchanged", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const recentRunMs = nowMs - 60_000;
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: recentRunMs,
      log: (line) => logs.push(line),
      minIntervalMs: 6 * 60 * 60 * 1000,
      nowMs,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(logs).toHaveLength(0);
    expect(state.lastRunMs).toBe(recentRunMs);
  });

  it("readHits throws — fail-soft: no log, state unchanged", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const prevLastRunMs = undefined;
    const readHits = vi.fn(async (): Promise<readonly RecallHitLike[]> => { throw new Error("disk error"); });
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: prevLastRunMs,
      log: (line) => logs.push(line),
      nowMs,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(readHits).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(0);
    expect(state.lastRunMs).toBe(prevLastRunMs);
  });

  it("persist provided + brake passes — persist called once, log contains 'promoted' + 'persisted', nextState.lastRunMs===nowMs", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const persist = vi.fn(async () => ({ promoted: 3 }));
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: (line) => logs.push(line),
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      persist,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/promoted/);
    expect(logs[0]).toMatch(/persisted/);
    expect(state.lastRunMs).toBe(nowMs);
  });

  it("persist provided but brake fails — persist NOT called, state unchanged", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const recentRunMs = nowMs - 60_000;
    const persist = vi.fn(async () => ({ promoted: 2 }));
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: recentRunMs,
      log: (line) => logs.push(line),
      minIntervalMs: 6 * 60 * 60 * 1000,
      nowMs,
      persist,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(persist).not.toHaveBeenCalled();
    expect(state.lastRunMs).toBe(recentRunMs);
  });

  it("persist NOT provided + brake passes — report-only log, no mutation (regression)", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: (line) => logs.push(line),
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/report-only/);
    expect(state.lastRunMs).toBe(nowMs);
  });

  it("persist throws + brake passes — fail-soft: no throw, state advances, log emitted", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const persist = vi.fn(async (): Promise<{ promoted: number }> => { throw new Error("store error"); });
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: (line) => logs.push(line),
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      persist,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/consolidate-memory:/);
    expect(state.lastRunMs).toBe(nowMs);
  });

  it("persistFade provided + brake passes — called once with the COMPUTED fade keys (matches the logged fade count, >0)", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    let persisted: readonly string[] | undefined;
    const persistFade = vi.fn(async (keys: readonly string[]) => { persisted = keys; });
    const readHits = vi.fn(async () => makeFadingHits(3, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: (line) => logs.push(line),
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      persistFade,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(persistFade).toHaveBeenCalledTimes(1);
    const logged = Number(/(\d+) fading/.exec(logs[0] ?? "")?.[1]);
    expect(logged).toBeGreaterThan(0); // the fixture really does fade — non-vacuous
    expect(persisted).toHaveLength(logged); // persisted the REAL computed fade set, not a constant
    expect(persisted).toContain("stale-0");
    expect(state.lastRunMs).toBe(nowMs);
  });

  it("persistFade provided but brake fails — persistFade NOT called, state unchanged", async () => {
    const nowMs = Date.now();
    const recentRunMs = nowMs - 60_000;
    const persistFade = vi.fn(async () => {});
    const readHits = vi.fn(async () => makeFadingHits(3, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: recentRunMs,
      log: () => {},
      minIntervalMs: 6 * 60 * 60 * 1000,
      nowMs,
      persistFade,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(persistFade).not.toHaveBeenCalled();
    expect(state.lastRunMs).toBe(recentRunMs);
  });

  it("useActrRanking ranks the capped fade set by ACT-R activation, not last-hit recency (matches the manual path)", async () => {
    const nowMs = Date.now();
    let persisted: readonly string[] | undefined;
    const persistFade = vi.fn(async (keys: readonly string[]) => { persisted = keys; });
    const readHits = vi.fn(async () => makeRecencyVsActrHits(nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: () => {},
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      useActrRanking: true,
      persistFade,
      readHits
    };
    await runMemoryConsolidationTick(deps);
    expect(persistFade).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(10); // default fade cap; 11 eligible → 1 dropped
    // ACT-R keeps the high-activation spaced record S (drops the most-recent single r0);
    // recency-only would do the opposite. This asserts the daemon now ranks like the manual path.
    expect(persisted).toContain("r0");
    expect(persisted).not.toContain("S");
  });

  it("persistFade throws + brake passes — fail-soft: no throw, state advances", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const persistFade = vi.fn(async (): Promise<void> => { throw new Error("sidecar write error"); });
    const readHits = vi.fn(async () => makeFadingHits(3, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: true,
      lastRunMs: undefined,
      log: (line) => logs.push(line),
      minIntervalMs: 1,
      minNewHits: 1,
      nowMs,
      persistFade,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(persistFade).toHaveBeenCalledTimes(1);
    expect(state.lastRunMs).toBe(nowMs);
  });

  it("disabled + persist provided — persist not called, state unchanged (regression)", async () => {
    const nowMs = Date.now();
    const logs: string[] = [];
    const prevLastRunMs = nowMs - 99_000;
    const persist = vi.fn(async () => ({ promoted: 1 }));
    const readHits = vi.fn(async () => makeHits(5, nowMs));
    const deps: MemoryConsolidationTickDeps = {
      enabled: false,
      lastRunMs: prevLastRunMs,
      log: (line) => logs.push(line),
      nowMs,
      persist,
      readHits
    };
    const state = await runMemoryConsolidationTick(deps);
    expect(persist).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
    expect(state.lastRunMs).toBe(prevLastRunMs);
  });
});
