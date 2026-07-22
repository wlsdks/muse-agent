import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoteSpanIdentityV1, createSupersedesRelationV1 } from "@muse/recall";
import { describe, expect, it } from "vitest";

import { loadBoundedNotesIndex, loadIndexedNoteSource } from "./note-relations-context.js";
import {
  NoteRelationsOperationError,
  commitPreparedRemove,
  prepareRemoveRelation
} from "./note-relations-operations.js";
import { mutateNoteRelationsStore, readNoteRelationsStore, resolveNoteRelationsPathSnapshot } from "./note-relations-store.js";

describe("note relation operation confirmation evidence", () => {
  it("binds current and stale endpoint evidence independently before remove", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-remove-evidence-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
    await mkdir(paths.notesDir, { recursive: true, mode: 0o700 });
    const currentPath = join(paths.notesDir, "current.md");
    const stalePath = join(paths.notesDir, "stale.md");
    const currentText = "Current answer";
    const staleText = "Used to be old answer";
    await writeFile(currentPath, currentText, { mode: 0o600 });
    await writeFile(stalePath, staleText, { mode: 0o600 });
    const entry = (path: string, text: string) => ({
      path,
      mtimeMs: 1,
      sourceHash: createHash("sha256").update(text).digest("hex"),
      chunkerVersion: "muse.notes.chunk-text.v1",
      chunks: [{ file: path, chunkIndex: 0, text }]
    });
    await writeFile(paths.notesIndexFile, JSON.stringify({
      version: 2,
      model: "fixture",
      builtAtIso: "2026-07-21T00:00:00.000Z",
      embeddingCount: 2,
      embeddingDim: 3,
      files: [entry(currentPath, currentText), entry(stalePath, staleText)]
    }), { mode: 0o600 });
    const index = await loadBoundedNotesIndex(paths);
    const currentSource = await loadIndexedNoteSource(index, "current.md");
    const staleSource = await loadIndexedNoteSource(index, "stale.md");
    if (currentSource.status !== "resolved" || staleSource.status !== "resolved") throw new Error("fixture unavailable");
    const current = createNoteSpanIdentityV1({
      sourceBytes: currentSource.sourceBytes, sourceIndex: currentSource.sourceIndex,
      chunkIndex: 0, start: 0, end: Buffer.byteLength(currentText)
    });
    const stale = createNoteSpanIdentityV1({
      sourceBytes: staleSource.sourceBytes, sourceIndex: staleSource.sourceIndex,
      chunkIndex: 0, start: 0, end: Buffer.byteLength(staleText)
    });
    const relation = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: { context: { sourceBytes: currentSource.sourceBytes, sourceIndex: currentSource.sourceIndex }, identity: current },
      edgeId: "1".repeat(32),
      stale: { context: { sourceBytes: staleSource.sourceBytes, sourceIndex: staleSource.sourceIndex }, identity: stale }
    });
    await mutateNoteRelationsStore(paths, () => [relation]);

    await writeFile(currentPath, "changed current", { mode: 0o600 });
    const prepared = await prepareRemoveRelation(paths, relation.edgeId);
    await writeFile(currentPath, currentText, { mode: 0o600 });
    await writeFile(stalePath, "changed stale", { mode: 0o600 });

    await expect(commitPreparedRemove(paths, prepared)).rejects.toBeInstanceOf(NoteRelationsOperationError);
    expect((await readNoteRelationsStore(paths)).relations).toHaveLength(1);
    expect((await readNoteRelationsStore(paths)).revision).toBe(1);

    await unlink(paths.notesIndexFile);
    const missingIndexPrepared = await prepareRemoveRelation(paths, relation.edgeId);
    await writeFile(paths.notesIndexFile, "{}\n", { mode: 0o600 });
    await expect(commitPreparedRemove(paths, missingIndexPrepared)).rejects.toMatchObject({
      code: "CONFIRMATION_STALE"
    });
    expect((await readNoteRelationsStore(paths)).revision).toBe(1);
  });
});
