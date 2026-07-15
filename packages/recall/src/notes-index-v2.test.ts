import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { embeddingsSidecarPath, loadIndex, NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";

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
