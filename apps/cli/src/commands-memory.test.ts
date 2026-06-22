import type { RecallHitRecord } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { formatBeliefWhy, formatConsolidationPlan, promoteRecalledMemories, searchMemoryEntries } from "./commands-memory.js";

describe("formatBeliefWhy — honest about a key you had Muse FORGET", () => {
  const NOW = Date.parse("2026-06-21T00:00:00Z");
  const rec = (over: Record<string, unknown> = {}) => ({
    kind: "fact",
    key: "home_city",
    value: "Seoul",
    learnedAt: "2026-06-10T00:00:00Z",
    source: "user" as const,
    ...over
  });

  it("says you forgot it (cited by date) instead of resurfacing the stale pre-forget value", () => {
    const out = formatBeliefWhy(
      [rec({ value: "Seoul", learnedAt: "2026-06-10T00:00:00Z" }), rec({ value: "", learnedAt: "2026-06-19T00:00:00Z", retraction: true })],
      "home_city",
      NOW
    );
    expect(out).toContain('you had me forget "home_city" on 2026-06-19');
    expect(out).not.toContain("Seoul");
  });

  it("shows the normal provenance for a key RE-SET after a retraction (you reopened it)", () => {
    const out = formatBeliefWhy(
      [rec({ learnedAt: "2026-06-18T00:00:00Z", retraction: true }), rec({ value: "Busan", learnedAt: "2026-06-19T00:00:00Z" })],
      "home_city",
      NOW
    );
    expect(out).not.toContain("you had me forget");
    expect(out).toContain("home_city = Busan");
  });

  it("shows the normal provenance for a never-forgotten key", () => {
    const out = formatBeliefWhy([rec({ value: "Busan" })], "home_city", NOW);
    expect(out).toContain("home_city = Busan");
    expect(out).not.toContain("you had me forget");
  });

  it("shows the value PATH for a CHANGED belief, not just the count", () => {
    const out = formatBeliefWhy(
      [rec({ value: "Seoul", learnedAt: "2026-06-10T00:00:00Z" }), rec({ value: "Busan", learnedAt: "2026-06-20T00:00:00Z" })],
      "home_city",
      NOW
    );
    expect(out).toContain("value path: Seoul (2026-06-10) → Busan (2026-06-20)");
  });
});

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
