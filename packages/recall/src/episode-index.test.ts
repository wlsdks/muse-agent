import { promises as fsPromises } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEpisodeIndex, EPISODE_INDEX_SCHEMA_VERSION, episodeIndexStale, loadEpisodeIndex, type EpisodeIndex } from "./episode-index.js";

const ep = (id: string, summary: string) => ({
  id, userId: "u", startedAt: "2026-05-25T10:00:00Z", endedAt: "2026-05-25T10:30:00Z", summary
});
function countingEmbed() {
  let calls = 0;
  return { calls: () => calls, embedFn: async (): Promise<number[]> => { calls += 1; return [calls, 0, 0]; } };
}
const NOW = "2026-05-26T00:00:00Z";
const prevIndex = (entries: EpisodeIndex["entries"]): EpisodeIndex => ({ builtAtIso: "x", entries, model: "m", version: EPISODE_INDEX_SCHEMA_VERSION });

describe("episodeIndexStale — drives muse ask's episode auto-refresh", () => {
  const withEmbedding = (id: string, summary: string) => ({ ...ep(id, summary), embedding: [1, 0, 0] });

  it("is stale when no index exists yet", () => {
    expect(episodeIndexStale(undefined, [ep("e1", "a")], "m")).toBe(true);
  });

  it("is stale when the embed model differs (cross-model cosine is meaningless)", () => {
    const index = prevIndex([withEmbedding("e1", "a")]);
    expect(episodeIndexStale(index, [ep("e1", "a")], "other-model")).toBe(true);
  });

  it("is stale when a source episode is not yet in the index", () => {
    const index = prevIndex([withEmbedding("e1", "a")]);
    expect(episodeIndexStale(index, [ep("e1", "a"), ep("e2", "new session")], "m")).toBe(true);
  });

  it("is stale when an episode's summary changed since indexing (re-scored / edited)", () => {
    const index = prevIndex([withEmbedding("e1", "old summary")]);
    expect(episodeIndexStale(index, [ep("e1", "new summary")], "m")).toBe(true);
  });

  it("is fresh when every source episode is present with an unchanged summary", () => {
    const index = prevIndex([withEmbedding("e1", "a"), withEmbedding("e2", "b")]);
    expect(episodeIndexStale(index, [ep("e1", "a"), ep("e2", "b")], "m")).toBe(false);
  });

  it("a deleted episode does NOT force a rebuild (dropped at query time, not here)", () => {
    const index = prevIndex([withEmbedding("e1", "a"), withEmbedding("gone", "deleted")]);
    expect(episodeIndexStale(index, [ep("e1", "a")], "m")).toBe(false);
  });
});

describe("buildEpisodeIndex", () => {
  it("drops an episode deleted from source — the index holds only current episodes (no orphan)", async () => {
    const previous = prevIndex([{ ...ep("gone", "deleted"), embedding: [9, 9, 9] }]);
    const { embedFn } = countingEmbed();
    const { index } = await buildEpisodeIndex({ embedFn, episodes: [ep("e1", "kept")], model: "m", nowIso: NOW, previous });
    expect(index.entries.map((e) => e.id)).toEqual(["e1"]);
  });

  it("reuses a prior embedding when id+summary are unchanged (no re-embed)", async () => {
    const previous = prevIndex([{ ...ep("e1", "same"), embedding: [7, 7, 7] }]);
    const { embedFn, calls } = countingEmbed();
    const { index, embedded, skipped } = await buildEpisodeIndex({ embedFn, episodes: [ep("e1", "same")], model: "m", nowIso: NOW, previous });
    expect([embedded, skipped, calls()]).toEqual([0, 1, 0]);
    expect(index.entries[0]!.embedding).toEqual([7, 7, 7]);
  });

  it("re-embeds when the summary changed for the same id", async () => {
    const previous = prevIndex([{ ...ep("e1", "old"), embedding: [7, 7, 7] }]);
    const { embedFn, calls } = countingEmbed();
    const { embedded, skipped } = await buildEpisodeIndex({ embedFn, episodes: [ep("e1", "new")], model: "m", nowIso: NOW, previous });
    expect([embedded, skipped, calls()]).toEqual([1, 0, 1]);
  });

  it("force re-embeds everything, ignoring the prior index", async () => {
    const previous = prevIndex([{ ...ep("e1", "same"), embedding: [7, 7, 7] }]);
    const { embedFn, calls } = countingEmbed();
    const { embedded } = await buildEpisodeIndex({ embedFn, episodes: [ep("e1", "same")], force: true, model: "m", nowIso: NOW, previous });
    expect([embedded, calls()]).toEqual([1, 1]);
  });
});

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

describe("loadEpisodeIndex — version-mismatch backup (DS-20: episodes are NOT re-derivable if the index write-back silently wipes the source of truth)", () => {
  let dir: string;
  let file: string;

  const mismatchedPayload = {
    version: 999,
    model: "m",
    builtAtIso: "2026-05-21T10:00:00Z",
    entries: [{ id: "e1", userId: "u", summary: "s", startedAt: "a", endedAt: "b", embedding: [0.1, 0.2] }]
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-episode-index-version-test-"));
    file = join(dir, "episodes-index.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("still returns undefined on a version mismatch (existing behavior preserved)", async () => {
    await writeFile(file, JSON.stringify(mismatchedPayload));
    expect(await loadEpisodeIndex(file)).toBeUndefined();
  });

  it("preserves the original file's content at a backup path before falling back to undefined", async () => {
    const raw = JSON.stringify(mismatchedPayload);
    await writeFile(file, raw);
    await loadEpisodeIndex(file);
    const entries = await readdir(dir);
    const backupName = entries.find((name) => name.startsWith("episodes-index.json.bak-v999-"));
    expect(backupName).toBeDefined();
    const backedUp = await readFile(join(dir, backupName!), "utf8");
    expect(backedUp).toBe(raw);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("does NOT create a backup when the version matches (regression guard — no behavior change on the healthy path)", async () => {
    await writeFile(file, JSON.stringify({ version: EPISODE_INDEX_SCHEMA_VERSION, model: "m", builtAtIso: "x", entries: [] }));
    await loadEpisodeIndex(file);
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes(".bak-"))).toBe(false);
  });

  it("a backup-rename failure is fail-soft — the read still returns undefined without throwing", async () => {
    await writeFile(file, JSON.stringify(mismatchedPayload));
    const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(loadEpisodeIndex(file)).resolves.toBeUndefined();
    expect(renameSpy).toHaveBeenCalled();
  });
});
