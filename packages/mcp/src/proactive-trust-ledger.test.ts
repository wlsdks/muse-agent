import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSurfaced,
  avoidedSourceKeys,
  computeTrustScore,
  isSourceAvoided,
  readTrustLedger,
  recordLatestOutcome,
  recordOutcome,
  sourceKey,
  withinDailyCap,
  type ProactiveOutcome,
  type TrustLedgerEntry
} from "@muse/stores";

const surfaced = (over: Partial<TrustLedgerEntry> = {}): TrustLedgerEntry => ({
  kind: "calendar",
  sourceKey: "calendar:evt-1",
  surfacedAtMs: 1_000,
  title: "Standup",
  ...over
});

const LATEST_OUTCOME_WORKER = String.raw`
const { recordLatestOutcome } = await import(process.argv[1]);
const [file, outcome, atMs] = process.argv.slice(2);
const result = await recordLatestOutcome(file, outcome, Number(atMs));
if (result === undefined) {
  console.error("No unrated proactive surface is available.");
  process.exitCode = 1;
} else {
  console.log("Recorded " + result.sourceKey + ".");
}
`;

async function runLatestOutcomeChild(
  file: string,
  outcome: ProactiveOutcome,
  atMs: number
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  const moduleUrl = new URL("../../stores/src/proactive-trust-ledger.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    LATEST_OUTCOME_WORKER,
    moduleUrl,
    file,
    outcome,
    atMs.toString()
  ], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr, stdout }));
  });
}

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

  it("recordLatestOutcome selects and records the newest real unrated surface atomically", async () => {
    await writeFile(file, JSON.stringify({ surfaced: [
      surfaced({ sourceKey: "task:older", surfacedAtMs: 1_000 }),
      surfaced({ outcome: "acted", sourceKey: "task:rated", surfacedAtMs: 9_000 }),
      surfaced({ recordedWithoutSurface: true, sourceKey: "task:synthetic", surfacedAtMs: 10_000 }),
      surfaced({ sourceKey: "task:tied-first", surfacedAtMs: 5_000 }),
      surfaced({ sourceKey: "task:tied-later", surfacedAtMs: 5_000 })
    ] }), "utf8");

    expect(await recordLatestOutcome(file, "kept", 11_000)).toEqual({
      sourceKey: "task:tied-later",
      title: "Standup"
    });
    const entries = await readTrustLedger(file);
    expect(entries[3]!.outcome).toBeUndefined();
    expect(entries[4]).toMatchObject({ outcome: "kept", outcomeAtMs: 11_000 });
  });

  it("does not append a reversal when concurrent latest ratings contend for one surface", async () => {
    await appendSurfaced(file, { id: "only", kind: "task", surfacedAtMs: 5_000, title: "Only" });

    const results = await Promise.all([
      recordLatestOutcome(file, "acted", 6_000),
      recordLatestOutcome(file, "kept", 7_000)
    ]);

    expect(results).toEqual([{ sourceKey: "task:only", title: "Only" }, undefined]);
    const entries = await readTrustLedger(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("acted");
    expect(entries[0]!.recordedWithoutSurface).toBeUndefined();
  });

  it("serializes latest ratings across real processes so exactly one succeeds", async () => {
    await writeFile(file, JSON.stringify({ surfaced: [surfaced({ sourceKey: "task:only" })] }), "utf8");

    const results = await Promise.all([
      runLatestOutcomeChild(file, "acted", 6_000),
      runLatestOutcomeChild(file, "kept", 7_000)
    ]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const winner = results.find((result) => result.code === 0)!;
    const loser = results.find((result) => result.code === 1)!;
    expect(winner.stdout).toContain("Recorded task:only");
    expect(loser.stderr).toContain("No unrated proactive surface is available");
    const entries = await readTrustLedger(file);
    expect(entries).toHaveLength(1);
    expect(["acted", "kept"]).toContain(entries[0]!.outcome);
    expect(entries[0]!.recordedWithoutSurface).toBeUndefined();
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
