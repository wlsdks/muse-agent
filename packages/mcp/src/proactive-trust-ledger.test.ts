import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSurfaced,
  avoidedSourceKeys,
  computeTrustScore,
  isSourceAvoided,
  readTrustLedger,
  recordOutcome,
  sourceKey,
  withinDailyCap,
  type TrustLedgerEntry
} from "@muse/stores";

const surfaced = (over: Partial<TrustLedgerEntry> = {}): TrustLedgerEntry => ({
  kind: "calendar",
  sourceKey: "calendar:evt-1",
  surfacedAtMs: 1_000,
  title: "Standup",
  ...over
});

describe("proactive-trust-ledger — pure scoring", () => {
  it("sourceKey is the kind:id avoidance unit", () => {
    expect(sourceKey("task", "t-9")).toBe("task:t-9");
  });

  it("precision is the non-vetoed fraction; null with no signal", () => {
    expect(computeTrustScore([]).precision).toBeNull();
    const score = computeTrustScore([
      surfaced({ outcome: "kept" }),
      surfaced({ outcome: "acted" }),
      surfaced({ outcome: "vetoed" }),
      surfaced() // unrated still counts as not-annoying
    ]);
    expect(score).toMatchObject({ acted: 1, kept: 1, rated: 3, surfaced: 4, vetoed: 1 });
    expect(score.precision).toBeCloseTo(0.75, 5);
  });

  it("avoidedSourceKeys / isSourceAvoided reflect only vetoes (learned avoidance)", () => {
    const entries = [
      surfaced({ kind: "calendar", outcome: "vetoed", sourceKey: "calendar:evt-1" }),
      surfaced({ kind: "task", outcome: "kept", sourceKey: "task:t-2" })
    ];
    expect([...avoidedSourceKeys(entries)]).toEqual(["calendar:evt-1"]);
    expect(isSourceAvoided(entries, "calendar", "evt-1")).toBe(true);
    expect(isSourceAvoided(entries, "task", "t-2")).toBe(false);
  });

  it("withinDailyCap counts only surfaces inside the trailing window", () => {
    const now = 10 * 60 * 60 * 1_000;
    const entries = [
      surfaced({ surfacedAtMs: now - 1_000 }),
      surfaced({ surfacedAtMs: now - 2_000 }),
      surfaced({ surfacedAtMs: now - 48 * 60 * 60 * 1_000 }) // older than 24h → not counted
    ];
    expect(withinDailyCap(entries, now, 3)).toBe(true); // 2 recent < 3
    expect(withinDailyCap(entries, now, 2)).toBe(false); // 2 recent, cap 2 → at limit
    expect(withinDailyCap(entries, now, 0)).toBe(false); // cap 0 disables
  });
});

describe("proactive-trust-ledger — persistence", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-trust-"));
    file = join(dir, "proactive-trust.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("missing / corrupt / wrong-shape file reads as empty", async () => {
    expect(await readTrustLedger(file)).toEqual([]);
    await writeFile(file, "{ not json", "utf8");
    expect(await readTrustLedger(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ surfaced: "nope" }), "utf8");
    expect(await readTrustLedger(file)).toEqual([]);
  });

  it("drops corrupt rows but keeps valid ones", async () => {
    await writeFile(file, JSON.stringify({ surfaced: [surfaced(), { bad: true }, 42] }), "utf8");
    const read = await readTrustLedger(file);
    expect(read).toHaveLength(1);
    expect(read[0]!.sourceKey).toBe("calendar:evt-1");
  });

  it("appendSurfaced records the kind:id source", async () => {
    await appendSurfaced(file, { id: "evt-7", kind: "calendar", surfacedAtMs: 5_000, title: "Review" });
    const read = await readTrustLedger(file);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ kind: "calendar", sourceKey: "calendar:evt-7", title: "Review" });
    expect(read[0]!.outcome).toBeUndefined();
  });

  it("recordOutcome rates the most-recent unrated surface for the source", async () => {
    await appendSurfaced(file, { id: "evt-7", kind: "calendar", surfacedAtMs: 5_000, title: "Review" });
    const res = await recordOutcome(file, "calendar:evt-7", "vetoed", 9_000);
    expect(res).toEqual({ matched: true, title: "Review" });
    const read = await readTrustLedger(file);
    expect(read[0]).toMatchObject({ outcome: "vetoed", outcomeAtMs: 9_000 });
    expect(isSourceAvoided(read, "calendar", "evt-7")).toBe(true);
  });

  it("recordOutcome on a never-surfaced source remembers the veto but does NOT inflate precision", async () => {
    const res = await recordOutcome(file, "task:t-3", "vetoed", 4_000);
    expect(res.matched).toBe(false);
    const read = await readTrustLedger(file);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ kind: "task", outcome: "vetoed", recordedWithoutSurface: true, sourceKey: "task:t-3" });
    // Learned avoidance still picks it up...
    expect(avoidedSourceKeys(read).has("task:t-3")).toBe(true);
    // ...but it is NOT counted as a surfaced notice (no fabricated denominator).
    const score = computeTrustScore(read);
    expect(score.surfaced).toBe(0);
    expect(score.vetoed).toBe(0);
    expect(score.precision).toBeNull();
  });

  it("a pre-veto does not dilute precision of a real surface", async () => {
    await appendSurfaced(file, { id: "real", kind: "task", surfacedAtMs: 1_000, title: "Real" });
    await recordOutcome(file, "task:real", "kept", 2_000);
    await recordOutcome(file, "calendar:never-shown", "vetoed", 3_000); // pre-veto
    const score = computeTrustScore(await readTrustLedger(file));
    expect(score.surfaced).toBe(1); // only the real surface
    expect(score.kept).toBe(1);
    expect(score.precision).toBe(1); // not dragged down by the pre-veto
  });

  it("round-trips a written ledger losslessly", async () => {
    await appendSurfaced(file, { id: "a", kind: "task", surfacedAtMs: 1, title: "A" });
    await appendSurfaced(file, { id: "b", kind: "calendar", surfacedAtMs: 2, title: "B" });
    await recordOutcome(file, "task:a", "kept", 3);
    const raw = JSON.parse(await readFile(file, "utf8")) as { surfaced: unknown[] };
    expect(raw.surfaced).toHaveLength(2);
    expect(computeTrustScore(await readTrustLedger(file)).precision).toBe(1);
  });

  // Concurrency (shared atomic-file helper migration): appendSurfaced /
  // recordOutcome are read-modify-write, and the trust score that GATES
  // proactivity is computed from this ledger — a clobbered append corrupts the
  // precision the gate reads (and could wrongly keep Muse proactive or silence it).
  describe("concurrent ledger mutation", () => {
    it("preserves EVERY surfaced record written concurrently (no last-writer-wins loss)", async () => {
      await Promise.all(Array.from({ length: 20 }, (_unused, i) =>
        appendSurfaced(file, { id: `t${i.toString()}`, kind: "task", surfacedAtMs: 1_000 + i, title: `T${i.toString()}` })));
      expect(await readTrustLedger(file)).toHaveLength(20);
    });

    it("applies every concurrent outcome to its own surface (the gate's precision stays consistent)", async () => {
      await Promise.all(Array.from({ length: 20 }, (_unused, i) =>
        appendSurfaced(file, { id: `t${i.toString()}`, kind: "task", surfacedAtMs: 1_000 + i, title: `T${i.toString()}` })));
      const outcomes = await Promise.all((await readTrustLedger(file)).map((e) => recordOutcome(file, e.sourceKey, "kept", 5_000)));
      expect(outcomes.every((o) => o.matched)).toBe(true);
      const score = computeTrustScore(await readTrustLedger(file));
      expect(score.surfaced).toBe(20);
      expect(score.kept).toBe(20);
      expect(score.precision).toBe(1); // all 20 kept → perfect, not corrupted by a lost write
    });
  });
});
