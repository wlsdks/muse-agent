import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NoteRelationsContextError,
  loadBoundedNotesIndex,
  loadIndexedNoteSource
} from "./note-relations-context.js";
import { resolveNoteRelationsPathSnapshot } from "./note-relations-store.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "muse-note-context-"));
  const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
  await mkdir(paths.notesDir, { recursive: true, mode: 0o700 });
  const sourcePath = join(paths.notesDir, "facts.md");
  const source = "Current answer\n\n~~Old answer~~";
  await writeFile(sourcePath, source, { mode: 0o600 });
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const index = {
    version: 2,
    model: "fixture",
    builtAtIso: "2026-07-21T00:00:00.000Z",
    embeddingCount: 2,
    embeddingDim: 3,
    files: [{
      path: sourcePath,
      mtimeMs: 1,
      sourceHash,
      chunkerVersion: "muse.notes.chunk-text.v1",
      chunks: [
        { file: sourcePath, chunkIndex: 0, text: "Current answer" },
        { file: sourcePath, chunkIndex: 1, text: "~~Old answer~~" }
      ]
    }]
  };
  await writeFile(paths.notesIndexFile, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  return { index, paths, source, sourceHash, sourcePath };
}

describe("bounded note-relations context", () => {
  it("loads one exact v2 index and resolves a source through no-follow provenance", async () => {
    const { paths, sourceHash } = await fixture();
    const index = await loadBoundedNotesIndex(paths);
    expect(index.rawDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(index.entries.map((entry) => entry.relativePath)).toEqual(["facts.md"]);

    const source = await loadIndexedNoteSource(index, "facts.md");
    expect(source.status).toBe("resolved");
    if (source.status !== "resolved") throw new Error("expected resolved source");
    expect(source.sourceIndex).toMatchObject({
      sourcePath: "facts.md",
      sourceHash,
      notesIndexSchema: 2,
      chunkerVersion: "muse.notes.chunk-text.v1"
    });
    expect(Buffer.from(source.sourceBytes).toString("utf8")).toContain("Current answer");
    expect(Object.isFrozen(source.sourceIndex.chunks)).toBe(true);
  });

  it("rejects extra schema keys, duplicate relative paths, and mismatched chunk ownership", async () => {
    const { index, paths, sourcePath } = await fixture();
    const invalidIndexes = [
      { ...index, extra: true },
      { ...index, files: [...index.files, { ...index.files[0] }] },
      { ...index, files: [{ ...index.files[0], chunks: [{ file: `${sourcePath}.other`, chunkIndex: 0, text: "x" }] }] }
    ];
    for (const invalid of invalidIndexes) {
      await writeFile(paths.notesIndexFile, JSON.stringify(invalid), { mode: 0o600 });
      await expect(loadBoundedNotesIndex(paths)).rejects.toBeInstanceOf(NoteRelationsContextError);
    }
  });

  it("marks legacy/PDF entries unavailable and rejects source symlinks or raw hash drift", async () => {
    const { index, paths, sourcePath } = await fixture();
    const legacy = {
      ...index,
      files: [{ path: sourcePath, mtimeMs: 1, chunks: index.files[0]!.chunks }]
    };
    await writeFile(paths.notesIndexFile, JSON.stringify(legacy), { mode: 0o600 });
    const legacySnapshot = await loadBoundedNotesIndex(paths);
    await expect(loadIndexedNoteSource(legacySnapshot, "facts.md")).resolves.toEqual({
      reason: "legacy_or_pdf",
      status: "unavailable"
    });

    await writeFile(paths.notesIndexFile, JSON.stringify(index), { mode: 0o600 });
    await writeFile(sourcePath, "changed", { mode: 0o600 });
    await expect(loadIndexedNoteSource(await loadBoundedNotesIndex(paths), "facts.md")).resolves.toEqual({
      reason: "stale_source",
      status: "unavailable"
    });

    const target = join(paths.notesDir, "target.md");
    await writeFile(target, "Current answer", { mode: 0o600 });
    await writeFile(paths.notesIndexFile, JSON.stringify(index), { mode: 0o600 });
    await (await import("node:fs/promises")).unlink(sourcePath);
    await symlink(target, sourcePath);
    await expect(loadIndexedNoteSource(await loadBoundedNotesIndex(paths), "facts.md")).resolves.toEqual({
      reason: "unsafe_source",
      status: "unavailable"
    });
  });

  it("rejects a pathname replacement after verified-handle read instead of mixing inode evidence", async () => {
    const { paths, sourcePath } = await fixture();
    const index = await loadBoundedNotesIndex(paths);
    const moved = `${sourcePath}.moved`;
    const result = await loadIndexedNoteSource(index, "facts.md", {
      afterVerifiedRead: async () => {
        await rename(sourcePath, moved);
        await writeFile(sourcePath, "Current answer\n\nUsed to be old answer", { mode: 0o600 });
      }
    });
    expect(result).toEqual({ reason: "unsafe_source", status: "unavailable" });
  });

  it("caps actual source I/O when the opened file grows after its initial stat", async () => {
    const { paths, sourcePath } = await fixture();
    const index = await loadBoundedNotesIndex(paths);
    const result = await loadIndexedNoteSource(index, "facts.md", {
      beforeBoundedRead: () => truncate(sourcePath, 4 * 1_024 * 1_024 + 2)
    });
    expect(result).toEqual({ reason: "unsafe_source", status: "unavailable" });
  });
});
