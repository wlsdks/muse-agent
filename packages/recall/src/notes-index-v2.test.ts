import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOTES_CHUNKER_VERSION } from "./notes-chunk.js";
import {
  embeddingsSidecarPath,
  isNotesIndexStale,
  loadIndex,
  NOTES_INDEX_SCHEMA_VERSION,
  reindexNotes
} from "./notes-index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "notes-index-v2-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

const v1Index = () => ({
  builtAtIso: "2026-07-15T00:00:00.000Z",
  files: [
    { chunks: [{ chunkIndex: 0, embedding: [0.25, -0.5, 1], file: "a.md", text: "alpha" }], mtimeMs: 1, path: "a.md" },
    { chunks: [
      { chunkIndex: 0, embedding: [0.125, 0.75, -1], file: "b.md", text: "beta" },
      { chunkIndex: 1, embedding: [2, 3, 4], file: "b.md", text: "beta-2" }
    ], mtimeMs: 2, path: "b.md" }
  ],
  model: "test-embed",
  version: 1
});

describe("notes-index v2 — binary embedding sidecar", () => {
  it("persists exact text-source provenance through reindex and reload", async () => {
    const sourceText = "# 생활\n\n현재 집은 부산 해운대다.\n";
    const sourceBytes = Buffer.from(sourceText, "utf8");
    const notePath = join(dir, "생활.md");
    const indexPath = join(dir, "notes-index.json");
    await writeFile(notePath, sourceBytes);
    const expectedSourceHash = createHash("sha256").update(sourceBytes).digest("hex");

    const summary = await reindexNotes({
      baseUrlResolver: () => "http://127.0.0.1:11434",
      dir,
      fetchImpl: (async () => new Response(JSON.stringify({ embedding: [0.25, 0.75] }), { status: 200 })) as typeof globalThis.fetch,
      force: true,
      indexPath,
      model: "test-embed"
    });

    expect(summary.index.files[0]).toMatchObject({
      chunkerVersion: NOTES_CHUNKER_VERSION,
      sourceHash: expectedSourceHash
    });
    expect((await loadIndex(indexPath))?.files[0]).toMatchObject({
      chunkerVersion: NOTES_CHUNKER_VERSION,
      sourceHash: expectedSourceHash
    });
  });

  it("reindexes same-mtime text when its exact source bytes change", async () => {
    const originalText = "# 생활\n\n현재 집은 부산이다.\n";
    const changedText = "# 생활\n\n현재 집은 서울이다.\n";
    const notePath = join(dir, "생활.md");
    const indexPath = join(dir, "notes-index.json");
    const fixedTime = new Date("2026-07-21T00:00:00.000Z");
    let embedCalls = 0;
    const fetchImpl = (async () => {
      embedCalls += 1;
      return new Response(JSON.stringify({ embedding: [embedCalls, 0.75] }), { status: 200 });
    }) as typeof globalThis.fetch;
    await writeFile(notePath, originalText);
    await utimes(notePath, fixedTime, fixedTime);
    const originalMtimeMs = (await stat(notePath)).mtimeMs;

    await reindexNotes({
      baseUrlResolver: () => "http://127.0.0.1:11434",
      dir,
      fetchImpl,
      force: true,
      indexPath,
      model: "test-embed"
    });
    await writeFile(notePath, changedText);
    await utimes(notePath, fixedTime, fixedTime);
    expect((await stat(notePath)).mtimeMs).toBe(originalMtimeMs);

    expect(await isNotesIndexStale(dir, indexPath)).toBe(true);
    const reindexed = await reindexNotes({
      baseUrlResolver: () => "http://127.0.0.1:11434",
      dir,
      fetchImpl,
      indexPath,
      model: "test-embed"
    });

    expect(reindexed.embedded).toBe(1);
    expect(reindexed.skipped).toBe(0);
    expect(embedCalls).toBe(2);
    expect((await loadIndex(indexPath))?.files[0]).toMatchObject({
      chunks: [{ text: changedText.trim() }],
      sourceHash: createHash("sha256").update(changedText).digest("hex")
    });
  });

  it("retries a same-mtime source change after a failed embedding preserves the prior entry", async () => {
    const originalText = "# 생활\n\n현재 집은 부산이다.\n";
    const changedText = "# 생활\n\n현재 집은 서울이다.\n";
    const notePath = join(dir, "생활.md");
    const indexPath = join(dir, "notes-index.json");
    const fixedTime = new Date("2026-07-21T00:00:00.000Z");
    const originalSourceHash = createHash("sha256").update(originalText).digest("hex");
    const changedSourceHash = createHash("sha256").update(changedText).digest("hex");
    let embedCalls = 0;
    let failEmbedding = false;
    const fetchImpl = (async () => {
      embedCalls += 1;
      if (failEmbedding) throw new Error("embedding offline");
      return new Response(JSON.stringify({ embedding: [embedCalls, 0.75] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const reindex = (force = false) => reindexNotes({
      baseUrlResolver: () => "http://127.0.0.1:11434",
      dir,
      fetchImpl,
      ...(force ? { force: true } : {}),
      indexPath,
      model: "test-embed"
    });
    await writeFile(notePath, originalText);
    await utimes(notePath, fixedTime, fixedTime);
    const originalMtimeMs = (await stat(notePath)).mtimeMs;
    await reindex(true);

    await writeFile(notePath, changedText);
    await utimes(notePath, fixedTime, fixedTime);
    expect((await stat(notePath)).mtimeMs).toBe(originalMtimeMs);
    failEmbedding = true;
    const failed = await reindex();

    expect(failed).toMatchObject({ embedded: 0, failed: 1, skipped: 0 });
    expect((await loadIndex(indexPath))?.files[0]).toMatchObject({
      chunks: [{ text: originalText.trim() }],
      sourceHash: originalSourceHash
    });
    expect(await isNotesIndexStale(dir, indexPath)).toBe(true);

    failEmbedding = false;
    const retried = await reindex();
    expect(retried).toMatchObject({ embedded: 1, failed: 0, skipped: 0 });
    expect(embedCalls).toBe(3);
    expect((await loadIndex(indexPath))?.files[0]).toMatchObject({
      chunks: [{ text: changedText.trim() }],
      sourceHash: changedSourceHash
    });
  });

  it("migrates a v1 JSON losslessly: same vectors, sidecar written, JSON no longer carries arrays", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(indexPath, JSON.stringify(v1Index()));
    const loaded = await loadIndex(indexPath);
    expect(loaded?.version).toBe(NOTES_INDEX_SCHEMA_VERSION);
    expect([...loaded!.files[1]!.chunks[1]!.embedding]).toEqual([2, 3, 4]);
    expect((await stat(embeddingsSidecarPath(indexPath))).size).toBe(3 * 3 * 4);
    expect((await readFile(indexPath, "utf8"))).not.toContain("0.125");
  });

  it("a reloaded v2 index round-trips embeddings within float32 precision and keeps text/paths exact", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(indexPath, JSON.stringify(v1Index()));
    await loadIndex(indexPath);
    const reloaded = await loadIndex(indexPath);
    expect(reloaded?.files.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(reloaded?.files[0]?.chunks[0]?.text).toBe("alpha");
    const emb = reloaded!.files[0]!.chunks[0]!.embedding;
    expect(emb[0]).toBeCloseTo(0.25, 6);
    expect(emb[1]).toBeCloseTo(-0.5, 6);
  });

  it("a truncated sidecar is rejected (byte-length check) — stale, never mismatched vectors", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(indexPath, JSON.stringify(v1Index()));
    await loadIndex(indexPath);
    const sidecar = embeddingsSidecarPath(indexPath);
    const bytes = await readFile(sidecar);
    await writeFile(sidecar, bytes.subarray(0, bytes.byteLength - 4));
    expect(await loadIndex(indexPath)).toBeUndefined();
  });

  it("a missing sidecar is treated as no index (reindex path), not a crash", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(indexPath, JSON.stringify(v1Index()));
    await loadIndex(indexPath);
    await rm(embeddingsSidecarPath(indexPath));
    expect(await loadIndex(indexPath)).toBeUndefined();
  });

  it("rejects a sidecar whose declared vector count does not match metadata chunks", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(indexPath, JSON.stringify(v1Index()));
    await loadIndex(indexPath);
    const metadata = JSON.parse(await readFile(indexPath, "utf8")) as { embeddingCount: number };
    await writeFile(indexPath, JSON.stringify({ ...metadata, ...JSON.parse(await readFile(indexPath, "utf8")), embeddingCount: metadata.embeddingCount + 1 }));
    expect(await loadIndex(indexPath)).toBeUndefined();
  });

  it("treats malformed index metadata as stale instead of throwing from the loader", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(indexPath, JSON.stringify({ builtAtIso: "now", files: [{ chunks: null, mtimeMs: 1, path: "a.md" }], model: "m", version: NOTES_INDEX_SCHEMA_VERSION }));
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();
  });
});
