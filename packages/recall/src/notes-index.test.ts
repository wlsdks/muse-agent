import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadIndex, NOTES_INDEX_SCHEMA_VERSION, reindexNotes } from "./notes-index.js";

describe("loadIndex — pure reader and writer-owned mismatch backup", () => {
  let dir: string;
  let file: string;

  const mismatchedPayload = {
    version: 999,
    model: "nomic-embed-text",
    builtAtIso: "2026-05-21T10:00:00Z",
    files: [{ path: "/notes/a.md", mtimeMs: 1, chunks: [{ file: "/notes/a.md", chunkIndex: 0, text: "hello", embedding: [0.1, 0.2] }] }]
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-notes-index-version-test-"));
    file = join(dir, "notes-index.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("still returns undefined on a version mismatch (existing behavior preserved)", async () => {
    await writeFile(file, JSON.stringify(mismatchedPayload));
    expect(await loadIndex(file)).toBeUndefined();
  });

  it("does not rename or write a version mismatch while reading", async () => {
    const raw = JSON.stringify(mismatchedPayload);
    await writeFile(file, raw);
    await loadIndex(file);
    const entries = await readdir(dir);
    expect(entries).toEqual(["notes-index.json"]);
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("does NOT create a backup when the version matches (regression guard — no behavior change on the healthy path)", async () => {
    await writeFile(file, JSON.stringify({ version: NOTES_INDEX_SCHEMA_VERSION, model: "m", builtAtIso: "x", files: [] }));
    const index = await loadIndex(file);
    expect(index).toBeDefined();
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes(".bak-"))).toBe(false);
  });

  it("preserves a version mismatch only inside the required reindex writer transaction", async () => {
    const raw = JSON.stringify(mismatchedPayload);
    await writeFile(file, raw);
    await writeFile(join(dir, "a.md"), "alpha");
    await reindexNotes({
      dir,
      fetchImpl: (async () => new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 })) as typeof globalThis.fetch,
      indexPath: file,
      maxEmbeddingAttempts: 1,
      model: "test-model"
    });
    const backupName = (await readdir(dir)).find((name) => name.startsWith("notes-index.json.bak-v999-"));
    expect(backupName).toBeDefined();
    expect(await readFile(join(dir, backupName!), "utf8")).toBe(raw);
    expect((await loadIndex(file))?.model).toBe("test-model");
  });
});
