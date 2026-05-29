import { mkdtemp, rm } from "node:fs/promises";
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
});
