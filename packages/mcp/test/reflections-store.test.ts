import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addReflections, listReflections, MAX_REFLECTIONS, readReflections, type NewReflection } from "../src/reflections-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-reflections-"));
  file = join(dir, "reflections.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const ref = (over: Partial<NewReflection> = {}): NewReflection => ({
  createdAtMs: 100,
  id: "r1",
  insight: "Runs every morning",
  sourceIds: ["ep-1", "ep-2"],
  supportCount: 2,
  ...over
});

describe("reflections-store", () => {
  it("adds fresh reflections (returning the count) and round-trips the grounding fields", async () => {
    const added = await addReflections(file, [ref()]);
    expect(added).toBe(1);
    expect(await readReflections(file)).toEqual([{ createdAtMs: 100, id: "r1", insight: "Runs every morning", sourceIds: ["ep-1", "ep-2"], supportCount: 2 }]);
  });

  it("DEDUPES the same recurring theme across passes (normalised insight — case + whitespace)", async () => {
    await addReflections(file, [ref({ id: "a", insight: "Runs every morning" })]);
    const addedAgain = await addReflections(file, [ref({ id: "b", insight: "  runs   EVERY morning  " })]); // same normalised
    expect(addedAgain).toBe(0);
    expect(await readReflections(file)).toHaveLength(1);
  });

  it("dedupes within a single batch and skips an empty/whitespace insight", async () => {
    const added = await addReflections(file, [
      ref({ id: "a", insight: "Likes tea" }),
      ref({ id: "b", insight: "likes TEA" }), // dup in-batch
      ref({ id: "c", insight: "   " }) // empty after normalise → skipped
    ]);
    expect(added).toBe(1);
    expect((await readReflections(file)).map((r) => r.id)).toEqual(["a"]);
  });

  it("returns 0 for an empty incoming list (no write)", async () => {
    expect(await addReflections(file, [])).toBe(0);
  });

  it("tolerant read: missing / malformed / wrong-shape file → []", async () => {
    expect(await readReflections(join(dir, "nope.json"))).toEqual([]);
    await writeFile(file, "{ not json", "utf8");
    expect(await readReflections(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ reflections: "not-an-array" }), "utf8");
    expect(await readReflections(file)).toEqual([]);
  });

  it("filters a tampered entry (empty insight or non-finite supportCount) on read", async () => {
    await writeFile(file, JSON.stringify({
      reflections: [
        { createdAtMs: 1, id: "good", insight: "ok", sourceIds: ["e1"], supportCount: 2 },
        { createdAtMs: 2, id: "empty", insight: "", sourceIds: [], supportCount: 1 },
        { createdAtMs: 3, id: "nan", insight: "x", sourceIds: [], supportCount: Number.NaN }
      ]
    }), "utf8");
    expect((await readReflections(file)).map((r) => r.id)).toEqual(["good"]);
  });

  it("listReflections returns reflections newest-first", async () => {
    const entries = [ref({ createdAtMs: 100, id: "old" }), ref({ createdAtMs: 300, id: "new" }), ref({ createdAtMs: 200, id: "mid" })];
    expect(listReflections(entries).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });
});

describe("reflections-store — MAX_REFLECTIONS cap (recency-trimmed, agrees with display order)", () => {
  it("caps at MAX_REFLECTIONS, keeping the newest by createdAtMs and dropping the oldest", async () => {
    const batch: NewReflection[] = Array.from({ length: MAX_REFLECTIONS + 5 }, (_, i) => ref({
      createdAtMs: 1000 + i, id: `r${i.toString()}`, insight: `insight number ${i.toString()}`
    }));
    await addReflections(file, batch);
    const stored = await readReflections(file);
    expect(stored).toHaveLength(MAX_REFLECTIONS);
    const ids = new Set(stored.map((r) => r.id));
    expect(ids.has("r0")).toBe(false);   // oldest 5 evicted
    expect(ids.has("r4")).toBe(false);
    expect(ids.has(`r${(MAX_REFLECTIONS + 4).toString()}`)).toBe(true); // newest survives
  });

  it("evicts by RECENCY not insertion order: a backfilled older reflection is dropped, not a newer one inserted earlier", async () => {
    // Fill to the cap with createdAtMs 1000..(1000+MAX-1), inserted in order.
    const first: NewReflection[] = Array.from({ length: MAX_REFLECTIONS }, (_, i) => ref({
      createdAtMs: 1000 + i, id: `a${i.toString()}`, insight: `alpha ${i.toString()}`
    }));
    await addReflections(file, first);
    // Backfill ONE reflection with an OLDER timestamp (inserted LAST → end of array).
    await addReflections(file, [ref({ createdAtMs: 1, id: "backfill", insight: "a backfilled older insight" })]);
    const ids = new Set((await readReflections(file)).map((r) => r.id));
    // Recency-correct: the backfilled (oldest ts) is evicted; the array-oldest-by-
    // insertion (a0, ts 1000) survives. Insertion-order trim would do the opposite.
    expect(ids.has("backfill")).toBe(false);
    expect(ids.has("a0")).toBe(true);
    expect(ids.size).toBe(MAX_REFLECTIONS);
  });
});
