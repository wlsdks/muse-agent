import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { incrementFollowupLlmBudget } from "../src/personal-followup-llm-budget-store.js";
import { readPlanCache, recordPlanTemplate, type PlanCacheEntry } from "../src/personal-plan-cache-store.js";

let files: string[] = [];
const fresh = (label: string) => {
  const file = join(tmpdir(), `muse-${label}-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => { await Promise.all(files.map((f) => rm(f, { force: true }))); files = []; });

// The last two unserialized read-modify-write personal stores. Both used a
// non-queued read→write with a tmp-${pid}-${Date.now()} path: concurrent writes
// lost data and crashed with ENOENT. withFileMutationQueue fixes both.
describe("recordPlanTemplate under concurrency", () => {
  const entry = (id: string): PlanCacheEntry => ({
    createdAt: "2026-06-01T00:00:00Z",
    id,
    prompt: `goal ${id}`,
    steps: [{ args: {}, description: "step", tool: "noop" }],
    userId: "u"
  });

  it("keeps every concurrently-recorded plan template (no lost cache entry, no crash)", async () => {
    const file = fresh("plan-cache");
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => recordPlanTemplate(file, entry(`p${i.toString()}`))));
    const all = await readPlanCache(file);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((e) => e.id)).size).toBe(25);
  }, 30_000);
});

describe("incrementFollowupLlmBudget under concurrency", () => {
  it("accumulates EVERY concurrent increment (no lost count → the daily cap actually trips)", async () => {
    const file = fresh("llm-budget");
    // Before serialization, concurrent increments all read the same count and wrote
    // count+1, so the total under-counted and the budget gate never tripped.
    const results = await Promise.all(Array.from({ length: 25 }, () => incrementFollowupLlmBudget(file, "2026-06-01")));
    expect(Math.max(...results.map((r) => r.calls))).toBe(25);
  }, 30_000);
});
