import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_PLAN_CACHE_ENTRIES,
  queryPlanCache,
  readPlanCache,
  recordPlanTemplate,
  type PlanCacheEntry
} from "../src/personal-plan-cache-store.js";

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-plancache-"));
  return join(dir, "plan-cache.json");
}

const entry = (id: string, prompt: string, userId = "u"): PlanCacheEntry => ({
  createdAt: "2026-05-28T00:00:00.000Z",
  id,
  prompt,
  steps: [{ args: { q: "x" }, description: "find", tool: "notes_search" }],
  userId
});

describe("personal-plan-cache-store (Agentic Plan Caching, arXiv 2506.14852)", () => {
  it("records and queries a plan template by user", async () => {
    const file = await tmpFile();
    await recordPlanTemplate(file, entry("p1", "summarize my notes"));
    const out = await queryPlanCache(file, "u");
    expect(out).toHaveLength(1);
    expect(out[0]!.prompt).toBe("summarize my notes");
    expect(out[0]!.steps[0]!.tool).toBe("notes_search");
  });

  it("filters by userId", async () => {
    const file = await tmpFile();
    await recordPlanTemplate(file, entry("p1", "mine", "u"));
    await recordPlanTemplate(file, entry("p2", "theirs", "v"));
    expect(await queryPlanCache(file, "u")).toHaveLength(1);
    expect(await queryPlanCache(file, "v")).toHaveLength(1);
    expect(await queryPlanCache(file)).toHaveLength(2);
  });

  it("upserts by id (no duplicate) and caps at MAX_PLAN_CACHE_ENTRIES", async () => {
    const file = await tmpFile();
    await recordPlanTemplate(file, entry("p1", "first"));
    await recordPlanTemplate(file, entry("p1", "updated"));
    const afterUpsert = await queryPlanCache(file, "u");
    expect(afterUpsert).toHaveLength(1);
    expect(afterUpsert[0]!.prompt).toBe("updated");

    for (let i = 0; i < MAX_PLAN_CACHE_ENTRIES + 10; i += 1) {
      await recordPlanTemplate(file, entry(`bulk-${i.toString()}`, `prompt ${i.toString()}`));
    }
    expect((await readPlanCache(file)).length).toBeLessThanOrEqual(MAX_PLAN_CACHE_ENTRIES);
  });

  it("tolerates a missing file (returns [])", async () => {
    expect(await readPlanCache("/nonexistent/dir/plan-cache.json")).toEqual([]);
  });
});
