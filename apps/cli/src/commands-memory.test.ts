import type { RecallHitRecord } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { formatConsolidationPlan, promoteRecalledMemories, searchMemoryEntries } from "./commands-memory.js";

const facts = { name: "Jin", city: "Seoul", role: "engineer" };
const prefs = { reply_style: "concise", language: "Korean" };

describe("searchMemoryEntries — search across remembered facts & preferences", () => {
  it("matches on the key (case-insensitive) and labels the source", () => {
    const hits = searchMemoryEntries(facts, prefs, "CITY");
    expect(hits).toEqual([{ source: "fact", key: "city", value: "Seoul" }]);
  });

  it("matches on the value (case-insensitive)", () => {
    const hits = searchMemoryEntries(facts, prefs, "korean");
    expect(hits).toEqual([{ source: "preference", key: "language", value: "Korean" }]);
  });

  it("returns every match across both maps, facts before preferences", () => {
    const hits = searchMemoryEntries({ a: "concise note" }, { b: "concise" }, "concise");
    expect(hits.map((h) => h.source)).toEqual(["fact", "preference"]);
  });

  it("returns nothing for a blank query or no match", () => {
    expect(searchMemoryEntries(facts, prefs, "   ")).toEqual([]);
    expect(searchMemoryEntries(facts, prefs, "zzz")).toEqual([]);
  });
});

describe("promoteRecalledMemories — dreaming pass (store injected)", () => {
  const NOW = new Date("2026-05-01T00:00:00Z");
  const daysAgo = (d: number): number => NOW.getTime() - d * 24 * 60 * 60_000;

  function fakeStore(initialFacts: Record<string, string> = {}) {
    const facts: Record<string, string> = { ...initialFacts };
    return {
      facts,
      store: {
        findByUserId: async () => ({ facts }),
        forget: async (_u: string, key: string) => { delete facts[key]; },
        upsertFact: async (_u: string, key: string, value: string) => { facts[key] = value; }
      }
    };
  }

  const hits: readonly RecallHitRecord[] = [
    { hits: 6, key: "sess-hot", lastHitMs: daysAgo(1), summary: "the apartment-lease negotiation" },
    { hits: 4, key: "sess-warm", lastHitMs: daysAgo(5), summary: "your marathon training plan" },
    { hits: 1, key: "sess-rare", lastHitMs: daysAgo(1), summary: "one-off question" }
  ];

  it("promotes the top recall-useful summaries into recalled-N facts, ranked", async () => {
    const { store, facts } = fakeStore();
    const res = await promoteRecalledMemories({ store, userId: "stark", readHits: async () => hits, now: () => NOW });
    expect(res.promoted.map((p) => p.key)).toEqual(["sess-hot", "sess-warm"]); // sess-rare below minHits 3
    expect(facts["recalled-1"]).toBe("the apartment-lease negotiation");
    expect(facts["recalled-2"]).toBe("your marathon training plan");
  });

  it("is idempotent — re-running clears prior recalled-* and rewrites the current top set", async () => {
    const { store, facts } = fakeStore({ "recalled-1": "STALE old promotion", "recalled-2": "also stale", name: "Jin" });
    await promoteRecalledMemories({ store, userId: "stark", readHits: async () => hits.slice(0, 1), now: () => NOW });
    expect(facts["recalled-1"]).toBe("the apartment-lease negotiation");
    expect("recalled-2" in facts).toBe(false); // stale second slot cleared
    expect(facts.name).toBe("Jin"); // non-promoted facts untouched
  });

  it("promotes nothing when no memory clears the hit floor", async () => {
    const { store, facts } = fakeStore();
    const res = await promoteRecalledMemories({ store, userId: "stark", readHits: async () => [{ hits: 1, key: "x", lastHitMs: NOW.getTime() }], now: () => NOW });
    expect(res.promoted).toEqual([]);
    expect(Object.keys(facts)).toEqual([]);
  });
});

describe("formatConsolidationPlan — the sleep-consolidation readout (B2)", () => {
  it("shows promote + fade halves and labels it non-destructive", () => {
    const out = formatConsolidationPlan({
      promote: [{ key: "standup", hits: 12, score: 12 }],
      fade: [{ key: "old-trip", hits: 1, score: 0.02, ageDays: 120 }]
    });
    expect(out).toContain("promoting 1 salient");
    expect(out).toContain("standup");
    expect(out).toContain("fading 1");
    expect(out).toContain("old-trip");
    expect(out).toContain("down-ranked in recall");
    expect(out).toContain("not deleted");
  });

  it("says so when there is nothing to consolidate", () => {
    expect(formatConsolidationPlan({ promote: [], fade: [] })).toContain("nothing to consolidate");
  });
});
