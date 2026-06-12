import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readRecallHits, recordRecallHits } from "../src/personal-recall-hits-store.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-recall-hits-"));
  file = join(dir, "recall-hits.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("recall-hits store", () => {
  it("missing file → empty; ignores bad rows tolerantly", async () => {
    expect(await readRecallHits(file)).toEqual([]);
  });

  it("records a hit per recall, increments on repeat, and keeps the latest summary", async () => {
    await recordRecallHits(file, [{ key: "s1", summary: "talked about taxes" }, { key: "s2", summary: "the trip plan" }], 1_000);
    await recordRecallHits(file, [{ key: "s1", summary: "taxes again, deadline moved" }], 2_000);
    const records = await readRecallHits(file);
    const s1 = records.find((r) => r.key === "s1");
    const s2 = records.find((r) => r.key === "s2");
    expect(s1).toMatchObject({ hits: 2, key: "s1", lastHitMs: 2_000, summary: "taxes again, deadline moved" });
    expect(s2).toMatchObject({ hits: 1, key: "s2", lastHitMs: 1_000 });
  });

  it("de-dupes within a single recall (same session surfaced once = one hit) + skips blank keys", async () => {
    await recordRecallHits(file, [{ key: "s1" }, { key: "s1" }, { key: "  " }], 5_000);
    const records = await readRecallHits(file);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ hits: 1, key: "s1" });
  });

  it("keeps the prior summary when a later hit carries none", async () => {
    await recordRecallHits(file, [{ key: "s1", summary: "original" }], 1_000);
    await recordRecallHits(file, [{ key: "s1" }], 2_000);
    expect((await readRecallHits(file))[0]).toMatchObject({ hits: 2, summary: "original" });
  });

  // Concurrency (backlog P1/P4 + the recall-hit-recording flake seen under
  // parallel full-check load): two recalls firing close together each run
  // read→increment→write. Before the per-file mutation queue + randomUUID tmp,
  // the later write was built on a stale read and silently dropped the earlier
  // increment (lost hits), and same-ms tmp names collided into an ENOENT
  // rename crash. These assert lossless, crash-free concurrent recording.
  describe("concurrent recording", () => {
    it("preserves every increment when N recalls hit the SAME key concurrently (no lost writes)", async () => {
      await Promise.all(Array.from({ length: 25 }, () => recordRecallHits(file, [{ key: "sess-a" }], 1_000)));
      const hits = await readRecallHits(file);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ key: "sess-a", hits: 25 }); // not last-writer-wins (would be 1)
    });

    it("preserves every DISTINCT key under concurrent recalls (no clobber, no crash)", async () => {
      await Promise.all(Array.from({ length: 25 }, (_unused, i) => recordRecallHits(file, [{ key: `s${i.toString()}` }], 1_000)));
      const hits = await readRecallHits(file);
      expect(hits).toHaveLength(25);
      expect(hits.every((r) => r.hits === 1)).toBe(true);
    });

    it("isolates per-file: concurrent recording to two files never cross-contaminates", async () => {
      const fileB = join(dir, "recall-hits-b.json");
      await Promise.all([
        ...Array.from({ length: 10 }, () => recordRecallHits(file, [{ key: "a" }], 1_000)),
        ...Array.from({ length: 10 }, () => recordRecallHits(fileB, [{ key: "b" }], 1_000)),
      ]);
      expect((await readRecallHits(file))[0]).toMatchObject({ key: "a", hits: 10, lastHitMs: 1_000 });
      expect((await readRecallHits(fileB))[0]).toMatchObject({ key: "b", hits: 10, lastHitMs: 1_000 });
    });
  });

  describe("recentAccessMs — ACT-R access timestamp list", () => {
    it("accumulates timestamps chronologically across successive hits", async () => {
      await recordRecallHits(file, [{ key: "s1" }], 1_000);
      await recordRecallHits(file, [{ key: "s1" }], 2_000);
      await recordRecallHits(file, [{ key: "s1" }], 3_000);
      const records = await readRecallHits(file);
      const s1 = records.find((r) => r.key === "s1");
      expect(s1?.hits).toBe(3);
      expect(s1?.lastHitMs).toBe(3_000);
      expect(s1?.recentAccessMs).toEqual([1_000, 2_000, 3_000]);
    });

    it("trims to the last 20 when more than 20 hits are recorded", async () => {
      for (let i = 1; i <= 25; i++) {
        await recordRecallHits(file, [{ key: "s2" }], i * 100);
      }
      const records = await readRecallHits(file);
      const s2 = records.find((r) => r.key === "s2");
      expect(s2?.recentAccessMs?.length).toBe(20);
      expect(s2?.recentAccessMs?.[0]).toBe(6 * 100);
      expect(s2?.recentAccessMs?.[19]).toBe(25 * 100);
    });

    it("tolerates old records without recentAccessMs (no crash, field stays absent)", async () => {
      await writeFile(file, JSON.stringify({ hits: [{ key: "old", hits: 2, lastHitMs: 500 }] }), "utf8");
      const before = await readRecallHits(file);
      expect(before).toHaveLength(1);
      expect(before[0]?.recentAccessMs).toBeUndefined();

      await recordRecallHits(file, [{ key: "old" }], 600);
      const after = await readRecallHits(file);
      const old = after.find((r) => r.key === "old");
      expect(old?.hits).toBe(3);
      expect(old?.recentAccessMs).toEqual([600]);
    });

    it("sanitizes garbage entries in recentAccessMs, keeping only finite numbers", async () => {
      await writeFile(
        file,
        JSON.stringify({ hits: [{ key: "dirty", hits: 1, lastHitMs: 10, recentAccessMs: ["x", null, 5, null, 7] }] }),
        "utf8",
      );
      const records = await readRecallHits(file);
      const dirty = records.find((r) => r.key === "dirty");
      expect(dirty).toBeDefined();
      expect(dirty?.recentAccessMs).toEqual([5, 7]);
    });
  });
});
