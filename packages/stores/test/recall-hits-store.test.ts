import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFadedMemoryKeys, readRecallHits, recordRecallHits, writeFadedMemoryKeys } from "../src/personal-recall-hits-store.js";

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

    it("preserves an external hit committed while this process waits for the file lock", async () => {
      await recordRecallHits(file, [{ key: "local-first" }], 1_000);
      await writeFile(`${file}.lock`, "external writer", { flag: "wx" });
      const localHit = recordRecallHits(file, [{ key: "local-second" }], 3_000);
      await sleep(300);
      const first = (await readRecallHits(file))[0]!;
      await writeFile(file, `${JSON.stringify({ hits: [first, { hits: 1, key: "external", lastHitMs: 2_000 }] }, null, 2)}\n`);
      await unlink(`${file}.lock`);

      await localHit;
      expect((await readRecallHits(file)).map(({ key }) => key)).toEqual(["local-first", "external", "local-second"]);
    });
  });

  describe("faded-memory sidecar — Ebbinghaus closed loop (arXiv:2305.10250)", () => {
    it("write + read roundtrip returns the written keys", async () => {
      const fadeFile = join(dir, "memory-fade.json");
      await writeFadedMemoryKeys(fadeFile, ["sess-a", "sess-b"], Date.now());
      const keys = await readFadedMemoryKeys(fadeFile);
      expect(keys.has("sess-a")).toBe(true);
      expect(keys.has("sess-b")).toBe(true);
      expect(keys.size).toBe(2);
    });

    it("missing file → empty set (tolerant read)", async () => {
      const fadeFile = join(dir, "nonexistent-fade.json");
      expect((await readFadedMemoryKeys(fadeFile)).size).toBe(0);
    });

    it("corrupt file → empty set (tolerant read)", async () => {
      const fadeFile = join(dir, "corrupt-fade.json");
      await writeFile(fadeFile, "NOT_JSON{{{", "utf8");
      expect((await readFadedMemoryKeys(fadeFile)).size).toBe(0);
    });

    it("wrong-shape JSON → empty set (tolerant read)", async () => {
      const fadeFile = join(dir, "wrong-shape.json");
      await writeFile(fadeFile, JSON.stringify({ keys: "not-an-array" }), "utf8");
      expect((await readFadedMemoryKeys(fadeFile)).size).toBe(0);
    });

    it("overwrite replaces the entire set (latest wins)", async () => {
      const fadeFile = join(dir, "memory-fade.json");
      await writeFadedMemoryKeys(fadeFile, ["old-a", "old-b"], 1_000);
      await writeFadedMemoryKeys(fadeFile, ["new-x"], 2_000);
      const keys = await readFadedMemoryKeys(fadeFile);
      expect(keys.has("old-a")).toBe(false);
      expect(keys.has("new-x")).toBe(true);
      expect(keys.size).toBe(1);
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

  describe("queryHashes — the query-diversity gate's fuel (recall-promotion's minUniqueQueries)", () => {
    it("accumulates a queryHash per access, across successive hits", async () => {
      await recordRecallHits(file, [{ key: "s1", queryHash: "aaaa1111" }], 1_000);
      await recordRecallHits(file, [{ key: "s1", queryHash: "bbbb2222" }], 2_000);
      const s1 = (await readRecallHits(file)).find((r) => r.key === "s1");
      expect(s1?.queryHashes).toEqual(["aaaa1111", "bbbb2222"]);
    });

    it("an access with no queryHash leaves the array unchanged (legacy-compatible, no placeholder entry)", async () => {
      await recordRecallHits(file, [{ key: "s1", queryHash: "aaaa1111" }], 1_000);
      await recordRecallHits(file, [{ key: "s1" }], 2_000);
      const s1 = (await readRecallHits(file)).find((r) => r.key === "s1");
      expect(s1?.hits).toBe(2);
      expect(s1?.queryHashes).toEqual(["aaaa1111"]);
    });

    it("a record with NO queryHash ever recorded has queryHashes undefined (true legacy exemption)", async () => {
      await recordRecallHits(file, [{ key: "s1" }], 1_000);
      const s1 = (await readRecallHits(file)).find((r) => r.key === "s1");
      expect(s1?.queryHashes).toBeUndefined();
    });

    it("trims to the last 20 when more than 20 hashed accesses are recorded", async () => {
      for (let i = 1; i <= 25; i++) {
        await recordRecallHits(file, [{ key: "s2", queryHash: `h${i.toString().padStart(2, "0")}` }], i * 100);
      }
      const s2 = (await readRecallHits(file)).find((r) => r.key === "s2");
      expect(s2?.queryHashes?.length).toBe(20);
      expect(s2?.queryHashes?.[0]).toBe("h06");
      expect(s2?.queryHashes?.[19]).toBe("h25");
    });

    it("tolerates old records without queryHashes (no crash, field stays absent until a hashed hit arrives)", async () => {
      await writeFile(file, JSON.stringify({ hits: [{ key: "old", hits: 2, lastHitMs: 500 }] }), "utf8");
      await recordRecallHits(file, [{ key: "old" }], 600);
      const old = (await readRecallHits(file)).find((r) => r.key === "old");
      expect(old?.hits).toBe(3);
      expect(old?.queryHashes).toBeUndefined();

      await recordRecallHits(file, [{ key: "old", queryHash: "cccc3333" }], 700);
      const after = (await readRecallHits(file)).find((r) => r.key === "old");
      expect(after?.queryHashes).toEqual(["cccc3333"]);
    });

    it("sanitizes garbage entries in queryHashes, keeping only non-empty strings", async () => {
      await writeFile(
        file,
        JSON.stringify({ hits: [{ key: "dirty", hits: 1, lastHitMs: 10, queryHashes: ["ok1", null, "", 5, "ok2"] }] }),
        "utf8",
      );
      const dirty = (await readRecallHits(file)).find((r) => r.key === "dirty");
      expect(dirty?.queryHashes).toEqual(["ok1", "ok2"]);
    });
  });
});
