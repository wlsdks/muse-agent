import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EPISODE_INDEX_SCHEMA_VERSION, loadEpisodeIndex } from "./episode-index.js";

describe("loadEpisodeIndex — per-entry validation drops corrupt episode rows so a hand-edited / migrated ~/.muse/episodes-index.json can't crash `muse recall`'s cosineSimilarity on entry.embedding (the pre-fix `Cannot read properties of null (reading 'length')` symptom)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-episode-index-test-"));
    file = join(dir, "episodes-index.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeIndex(payload: unknown): Promise<void> {
    await writeFile(file, JSON.stringify(payload));
  }

  it("returns undefined when the file is missing / unparseable / wrong version / missing model / non-array entries (regression pin on the existing whole-file gates)", async () => {
    expect(await loadEpisodeIndex(join(dir, "no-such-file.json"))).toBeUndefined();

    await writeFile(file, "{not json");
    expect(await loadEpisodeIndex(file)).toBeUndefined();

    await writeIndex(null);
    expect(await loadEpisodeIndex(file)).toBeUndefined();

    await writeIndex({ version: 99, model: "m", entries: [] });
    expect(await loadEpisodeIndex(file)).toBeUndefined();

    await writeIndex({ version: EPISODE_INDEX_SCHEMA_VERSION, entries: [] });
    expect(await loadEpisodeIndex(file)).toBeUndefined();

    await writeIndex({ version: EPISODE_INDEX_SCHEMA_VERSION, model: "m", entries: "not-an-array" });
    expect(await loadEpisodeIndex(file)).toBeUndefined();
  });

  it("loads a well-formed index verbatim (per-entry validation is a no-op on healthy data)", async () => {
    const goodEntry = {
      id: "ep-1",
      userId: "u",
      summary: "Worked on goal 091",
      startedAt: "2026-05-21T08:00:00Z",
      endedAt: "2026-05-21T09:00:00Z",
      embedding: [0.1, 0.2, 0.3]
    };
    await writeIndex({
      version: EPISODE_INDEX_SCHEMA_VERSION,
      model: "nomic-embed-text",
      builtAtIso: "2026-05-21T10:00:00Z",
      entries: [goodEntry]
    });
    const index = await loadEpisodeIndex(file);
    expect(index).toBeDefined();
    expect(index?.model).toBe("nomic-embed-text");
    expect(index?.builtAtIso).toBe("2026-05-21T10:00:00Z");
    expect(index?.entries).toEqual([goodEntry]);
  });

  it("drops an entry whose `embedding` is null / undefined / non-array / contains a non-finite number — so cosineSimilarity(q, entry.embedding) at commands-recall.ts:99 can never crash on `.length` of a non-array", async () => {
    const goodEmbedding = [0.1, 0.2, 0.3];
    const base = {
      userId: "u",
      summary: "s",
      startedAt: "2026-05-21T00:00:00Z",
      endedAt: "2026-05-21T01:00:00Z"
    };
    await writeIndex({
      version: EPISODE_INDEX_SCHEMA_VERSION,
      model: "m",
      builtAtIso: "2026-05-21T10:00:00Z",
      entries: [
        { ...base, id: "ok", embedding: goodEmbedding },
        { ...base, id: "null-embed", embedding: null },
        { ...base, id: "string-embed", embedding: "not-an-array" },
        { ...base, id: "obj-embed", embedding: { length: 3 } },
        { ...base, id: "nan-embed", embedding: [0.1, Number.NaN, 0.3] },
        { ...base, id: "inf-embed", embedding: [Number.POSITIVE_INFINITY] },
        { ...base, id: "missing-embed" }
      ]
    });
    const index = await loadEpisodeIndex(file);
    expect(index?.entries.map((e) => e.id)).toEqual(["ok"]);
  });

  it("drops an entry missing any of the required string fields (id / userId / summary / startedAt / endedAt) — partial-write recovery can't leak a row with `.startedAt === undefined` into the recall ranker", async () => {
    const goodEmbedding = [0.5];
    await writeIndex({
      version: EPISODE_INDEX_SCHEMA_VERSION,
      model: "m",
      builtAtIso: "2026-05-21T10:00:00Z",
      entries: [
        { id: "no-userid", summary: "s", startedAt: "a", endedAt: "b", embedding: goodEmbedding },
        { id: "no-summary", userId: "u", startedAt: "a", endedAt: "b", embedding: goodEmbedding },
        { id: "no-started", userId: "u", summary: "s", endedAt: "b", embedding: goodEmbedding },
        { id: "no-ended", userId: "u", summary: "s", startedAt: "a", embedding: goodEmbedding },
        { userId: "u", summary: "s", startedAt: "a", endedAt: "b", embedding: goodEmbedding },
        { id: "", userId: "u", summary: "s", startedAt: "a", endedAt: "b", embedding: goodEmbedding }
      ]
    });
    const index = await loadEpisodeIndex(file);
    expect(index?.entries).toEqual([]);
  });

  it("defaults `builtAtIso` to '' when the field is missing / non-string — the recall path renders it verbatim so an undefined would surface as the literal 'undefined' string", async () => {
    await writeIndex({
      version: EPISODE_INDEX_SCHEMA_VERSION,
      model: "m",
      entries: []
    });
    expect((await loadEpisodeIndex(file))?.builtAtIso).toBe("");

    await writeIndex({
      version: EPISODE_INDEX_SCHEMA_VERSION,
      model: "m",
      builtAtIso: 42,
      entries: []
    });
    expect((await loadEpisodeIndex(file))?.builtAtIso).toBe("");
  });
});
