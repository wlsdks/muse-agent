import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readRagStatus, readRecentlyForgottenLine, readRecentlyLearnedLine, readTokenCostToday, resolveStatusWatchIntervalMs, suggestPatternHints } from "./commands-status.js";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-status-"));
  const p = join(dir, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

describe("readRagStatus", () => {
  it("reports not-indexed when the index file is missing", async () => {
    expect(await readRagStatus(join(tmpdir(), "does-not-exist-muse-rag.json"))).toEqual({ indexed: false });
  });

  it("reports indexed with the embed model + file count when present", async () => {
    const p = tmpFile("notes-index.json", JSON.stringify({ model: "nomic-embed-text", files: [{ path: "a.md" }, { path: "b.md" }] }));
    expect(await readRagStatus(p)).toEqual({ embedModel: "nomic-embed-text", files: 2, indexed: true });
  });

  it("treats an empty file list as not-indexed (no chunks to search)", async () => {
    const p = tmpFile("empty-index.json", JSON.stringify({ model: "nomic-embed-text", files: [] }));
    expect(await readRagStatus(p)).toEqual({ embedModel: "nomic-embed-text", files: 0, indexed: false });
  });

  it("omits the embed model when it's blank/missing but still counts files", async () => {
    const p = tmpFile("no-model.json", JSON.stringify({ model: "   ", files: [{ path: "a.md" }] }));
    expect(await readRagStatus(p)).toEqual({ files: 1, indexed: true });
  });
});

describe("readRecentlyLearnedLine", () => {
  function memFile(users: Record<string, unknown>): string {
    return tmpFile("user-memory.json", JSON.stringify({ version: 1, users }));
  }

  it("returns undefined when the store is missing or has no fact history", async () => {
    expect(await readRecentlyLearnedLine(join(tmpdir(), "no-such-muse-mem.json"), "stark")).toBeUndefined();
    const p = memFile({
      stark: { userId: "stark", facts: { name: "Stark" }, preferences: {}, recentTopics: [], updatedAt: "2026-06-21T00:00:00.000Z" }
    });
    expect(await readRecentlyLearnedLine(p, "stark")).toBeUndefined();
  });

  it("returns the compact cited one-liner derived from the user's factHistory", async () => {
    const p = memFile({
      stark: {
        userId: "stark",
        facts: { home_city: "Busan", role: "founder" },
        preferences: {},
        recentTopics: [],
        updatedAt: "2026-06-21T00:00:00.000Z",
        factHistory: [
          { key: "role", previousValue: "student", replacedAt: "2026-06-20T00:00:00.000Z", kind: "contradict" },
          { key: "home_city", previousValue: "Seoul", replacedAt: "2026-06-21T00:00:00.000Z", kind: "contradict" }
        ]
      }
    });
    const nowMs = new Date("2026-06-25T00:00:00.000Z").getTime(); // both within the 30-day window
    expect(await readRecentlyLearnedLine(p, "stark", nowMs)).toBe('home city: Busan (changed from "Seoul" on 2026-06-21) (+1 more)');
  });

  it("drops a learning older than the 30-day window so status stays truthfully 'recent'", async () => {
    const p = memFile({
      stark: {
        userId: "stark",
        facts: { home_city: "Busan", role: "founder" },
        preferences: {},
        recentTopics: [],
        updatedAt: "2026-06-21T00:00:00.000Z",
        factHistory: [
          { key: "role", previousValue: "student", replacedAt: "2026-01-01T00:00:00.000Z", kind: "contradict" },
          { key: "home_city", previousValue: "Seoul", replacedAt: "2026-06-20T00:00:00.000Z", kind: "contradict" }
        ]
      }
    });
    const nowMs = new Date("2026-06-25T00:00:00.000Z").getTime(); // role (Jan) is >30 days old, home_city (Jun 20) is in-window
    expect(await readRecentlyLearnedLine(p, "stark", nowMs)).toBe('home city: Busan (changed from "Seoul" on 2026-06-20)');
  });
});

describe("readRecentlyForgottenLine (the FORGETS half, compact)", () => {
  function provFile(entries: readonly unknown[]): string {
    return tmpFile("belief-provenance.json", JSON.stringify({ entries }));
  }

  it("returns undefined when the provenance store is missing or has no retractions", async () => {
    expect(await readRecentlyForgottenLine(join(tmpdir(), "no-such-prov.json"))).toBeUndefined();
    const p = provFile([{ userId: "stark", key: "home_city", kind: "fact", value: "Busan", learnedAt: "2026-06-20T00:00:00.000Z" }]);
    expect(await readRecentlyForgottenLine(p, new Date("2026-06-21T00:00:00.000Z").getTime())).toBeUndefined();
  });

  it("surfaces the most recent forgotten key with a (+N more) count, cited by date", async () => {
    const p = provFile([
      { userId: "stark", key: "old_employer", kind: "fact", value: "", learnedAt: "2026-06-19T00:00:00.000Z", retraction: true },
      { userId: "stark", key: "commute_mode", kind: "fact", value: "", learnedAt: "2026-06-18T00:00:00.000Z", retraction: true }
    ]);
    const nowMs = new Date("2026-06-21T00:00:00.000Z").getTime();
    expect(await readRecentlyForgottenLine(p, nowMs)).toBe("old employer (forgotten 2026-06-19) (+1 more)");
  });

  it("drops a retraction older than the 30-day window so status stays truthfully 'recent'", async () => {
    const p = provFile([{ userId: "stark", key: "old_employer", kind: "fact", value: "", learnedAt: "2026-01-01T00:00:00.000Z", retraction: true }]);
    const nowMs = new Date("2026-06-21T00:00:00.000Z").getTime();
    expect(await readRecentlyForgottenLine(p, nowMs)).toBeUndefined();
  });
});

describe("readTokenCostToday", () => {
  it("reports unavailable when the cost file is missing", async () => {
    expect(await readTokenCostToday(join(tmpdir(), "no-such-muse-cost.json"))).toEqual({ available: false });
  });

  it("reports available and spreads the persisted shape when present", async () => {
    const p = tmpFile("cost.json", JSON.stringify({ totalUsd: 0.42, byModel: { "ollama/qwen3:8b": 0 } }));
    expect(await readTokenCostToday(p)).toEqual({ available: true, totalUsd: 0.42, byModel: { "ollama/qwen3:8b": 0 } });
  });

  it("reports unavailable when the file holds a non-object scalar", async () => {
    const p = tmpFile("scalar-cost.json", "42");
    expect(await readTokenCostToday(p)).toEqual({ available: false });
  });
});

describe("resolveStatusWatchIntervalMs", () => {
  it("defaults to 5s when the raw value is absent", () => {
    expect(resolveStatusWatchIntervalMs(undefined)).toBe(5_000);
  });

  it("defaults to 5s on a non-numeric or non-positive value", () => {
    expect(resolveStatusWatchIntervalMs("abc")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("0")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("-5")).toBe(5_000);
  });

  it("converts seconds to ms and clamps to [1s, 3600s]", () => {
    expect(resolveStatusWatchIntervalMs("1")).toBe(1_000);
    expect(resolveStatusWatchIntervalMs("2.5")).toBe(2_500);
    expect(resolveStatusWatchIntervalMs("3600")).toBe(3_600_000);
    expect(resolveStatusWatchIntervalMs("99999")).toBe(3_600_000); // clamped to the 1h ceiling
  });
});

describe("suggestPatternHints", () => {
  // Build N firings of one pattern, each at the given UTC hour.
  const firedAt = (patternId: string, ...hoursUtc: number[]) =>
    hoursUtc.map((h, i) => ({ firedAtIso: `2026-05-20T${h.toString().padStart(2, "0")}:0${i % 6}:00Z`, patternId }));
  const now = new Date("2026-05-27T00:15:00Z"); // UTC hour 0

  it("returns nothing for an empty history", () => {
    expect(suggestPatternHints([], now)).toEqual([]);
  });

  it("requires at least minFirings (default 3) before suggesting", () => {
    expect(suggestPatternHints(firedAt("p", 0, 0), now)).toEqual([]); // only 2 firings
  });

  it("suggests a pattern whose habitual hour is within ±1 of now", () => {
    expect(suggestPatternHints(firedAt("standup", 0, 0, 0), now)).toEqual([
      { patternId: "standup", medianHourUtc: 0, firings: 3 }
    ]);
  });

  it("excludes a pattern whose habitual hour is outside the ±1 window", () => {
    expect(suggestPatternHints(firedAt("lunch", 12, 12, 12), now)).toEqual([]);
  });

  it("uses a CIRCULAR median so a midnight-straddling habit is matched (naive numeric median would miss it)", () => {
    // hours {22,23,0,1,2}: circular medoid is 0 (within ±1 of now); a plain
    // numeric median would be 2 and fall outside the window.
    expect(suggestPatternHints(firedAt("night-owl", 22, 23, 0, 1, 2), now)).toEqual([
      { patternId: "night-owl", medianHourUtc: 0, firings: 5 }
    ]);
  });

  it("matches across the midnight boundary (median 23, now 0 → delta 1)", () => {
    expect(suggestPatternHints(firedAt("wind-down", 23, 23, 23), now)).toEqual([
      { patternId: "wind-down", medianHourUtc: 23, firings: 3 }
    ]);
  });

  it("skips malformed entries without crashing", () => {
    const fired = [
      null,
      "nope",
      { patternId: 123, firedAtIso: "2026-05-20T00:00:00Z" }, // wrong-typed id
      { patternId: "x", firedAtIso: "not-a-date" }, // unparseable
      { patternId: "x" }, // missing firedAtIso
      ...firedAt("real", 0, 0, 0)
    ];
    expect(suggestPatternHints(fired, now)).toEqual([{ patternId: "real", medianHourUtc: 0, firings: 3 }]);
  });

  it("orders most-fired first and honours maxHints", () => {
    const fired = [...firedAt("a", 0, 0, 0), ...firedAt("b", 0, 0, 0, 0, 0)];
    expect(suggestPatternHints(fired, now, { maxHints: 1 })).toEqual([
      { patternId: "b", medianHourUtc: 0, firings: 5 }
    ]);
  });
});
