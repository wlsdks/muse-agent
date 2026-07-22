import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NoteRelationsStoreError,
  mutateNoteRelationsStore,
  readNoteRelationsStore,
  resolveNoteRelationsPathSnapshot,
  verifyNoteRelationsRoot
} from "./note-relations-store.js";

function storedRelation(edgeId: string, sourceSeed: string) {
  const identity = (sourcePath: string, seed: string) => ({
    schema: "muse.note-span.v1" as const,
    sourcePath,
    sourceHash: seed.repeat(64),
    notesIndexSchema: 2 as const,
    chunkerVersion: "muse.notes.chunk-text.v1" as const,
    sourceIndexDigest: "b".repeat(64),
    chunkIndex: 0,
    chunkHash: "c".repeat(64),
    start: 0,
    end: 4,
    spanHash: "d".repeat(64)
  });
  return {
    schema: "muse.note-relation.supersedes.v1" as const,
    edgeId,
    authoredAt: "2026-07-21T00:00:00.000Z",
    current: identity(`${sourceSeed}-current.md`, sourceSeed),
    stale: identity(`${sourceSeed}-stale.md`, sourceSeed === "a" ? "e" : "f")
  };
}

describe("note-relations path snapshot", () => {
  it("freezes one HOME-rooted path set and rejects relation files outside the direct .muse root", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-home-"));
    const env = {
      HOME: home,
      MUSE_NOTES_DIR: join(home, "notes"),
      MUSE_NOTES_INDEX_FILE: join(home, ".muse", "custom-index.json"),
      MUSE_NOTE_RELATIONS_FILE: join(home, ".muse", "custom-relations.json")
    };

    const snapshot = resolveNoteRelationsPathSnapshot(env);
    env.HOME = join(home, "changed");
    env.MUSE_NOTE_RELATIONS_FILE = join(home, "outside.json");

    expect(snapshot).toEqual({
      env: expect.objectContaining({ HOME: home }),
      home,
      lockFile: join(home, ".muse", "custom-relations.json.lock"),
      museRoot: join(home, ".muse"),
      notesDir: join(home, "notes"),
      notesIndexFile: join(home, ".muse", "custom-index.json"),
      storeFile: join(home, ".muse", "custom-relations.json")
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.env)).toBe(true);
    expect(snapshot.home).toBe(home);

    for (const storeFile of [
      join(home, "outside.json"),
      join(home, ".muse", "nested", "relations.json"),
      "relative-relations.json"
    ]) {
      expect(() => resolveNoteRelationsPathSnapshot({
        HOME: home,
        MUSE_NOTE_RELATIONS_FILE: storeFile
      })).toThrow(NoteRelationsStoreError);
    }
  });

  it("does not create a missing .muse on read, creates it privately for mutation, and rejects unsafe roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-root-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });

    const absent = await verifyNoteRelationsRoot(paths, { create: false });
    expect(absent).toMatchObject({ rootState: "absent" });
    await expect(lstat(paths.museRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const created = await verifyNoteRelationsRoot(paths, { create: true });
    expect(created).toMatchObject({ rootState: "present" });
    expect((await lstat(paths.museRoot)).mode & 0o777).toBe(0o700);

    await chmod(paths.museRoot, 0o722);
    await expect(verifyNoteRelationsRoot(paths, { create: false })).rejects.toBeInstanceOf(NoteRelationsStoreError);

    const symlinkHome = await mkdtemp(join(tmpdir(), "muse-note-relations-symlink-home-"));
    const target = join(symlinkHome, "target");
    const linkedRoot = join(symlinkHome, ".muse");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linkedRoot);
    await expect(verifyNoteRelationsRoot(
      resolveNoteRelationsPathSnapshot({ HOME: symlinkHome }),
      { create: false }
    )).rejects.toBeInstanceOf(NoteRelationsStoreError);
  });

  it("distinguishes absent and empty stores and preserves structurally corrupt bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-read-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });

    expect(await readNoteRelationsStore(paths)).toEqual({
      rawDigest: null,
      relations: [],
      revision: 0,
      state: "absent"
    });

    await verifyNoteRelationsRoot(paths, { create: true });
    const emptyRaw = `${JSON.stringify({
      relations: [],
      revision: 0,
      schema: "muse.note-relations.store.v1"
    }, null, 2)}\n`;
    await writeFile(paths.storeFile, emptyRaw, { encoding: "utf8", mode: 0o600 });
    expect(await readNoteRelationsStore(paths)).toEqual({
      rawDigest: createHash("sha256").update(emptyRaw).digest("hex"),
      relations: [],
      revision: 0,
      state: "empty"
    });

    const corruptRaw = `${JSON.stringify({
      extra: true,
      relations: [],
      revision: 0,
      schema: "muse.note-relations.store.v1"
    })}\n`;
    await writeFile(paths.storeFile, corruptRaw, { encoding: "utf8", mode: 0o600 });
    const before = await lstat(paths.storeFile);
    await expect(readNoteRelationsStore(paths)).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    const after = await lstat(paths.storeFile);
    expect(await readFile(paths.storeFile, "utf8")).toBe(corruptRaw);
    expect({ ino: after.ino, mode: after.mode, mtimeMs: after.mtimeMs }).toEqual({
      ino: before.ino,
      mode: before.mode,
      mtimeMs: before.mtimeMs
    });
  });

  it("rejects unsafe or oversized store nodes without changing them", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-unsafe-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
    await verifyNoteRelationsRoot(paths, { create: true });
    await writeFile(paths.storeFile, "{}\n", { mode: 0o644 });
    await expect(readNoteRelationsStore(paths)).rejects.toMatchObject({ code: "STORE_UNSAFE" });
    expect((await lstat(paths.storeFile)).mode & 0o777).toBe(0o644);

    await chmod(paths.storeFile, 0o600);
    await truncate(paths.storeFile, 4 * 1_024 * 1_024 + 1);
    await expect(readNoteRelationsStore(paths)).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    expect((await lstat(paths.storeFile)).size).toBe(4 * 1_024 * 1_024 + 1);

    const symlinkHome = await mkdtemp(join(tmpdir(), "muse-note-relations-file-link-"));
    const linkedPaths = resolveNoteRelationsPathSnapshot({ HOME: symlinkHome });
    await verifyNoteRelationsRoot(linkedPaths, { create: true });
    const target = join(symlinkHome, "target.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, linkedPaths.storeFile);
    await expect(readNoteRelationsStore(linkedPaths)).rejects.toMatchObject({ code: "STORE_UNSAFE" });
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it("caps actual store I/O when the opened file grows after its initial stat", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-grow-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
    await verifyNoteRelationsRoot(paths, { create: true });
    await writeFile(paths.storeFile, JSON.stringify({
      schema: "muse.note-relations.store.v1", revision: 0, relations: []
    }), { mode: 0o600 });
    await expect(readNoteRelationsStore(paths, {
      beforeBoundedRead: () => truncate(paths.storeFile, 4 * 1_024 * 1_024 + 2)
    })).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });

  it("accepts only exact canonical stored relation records", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-schema-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
    await verifyNoteRelationsRoot(paths, { create: true });
    const identity = (sourcePath: string, seed: string) => ({
      schema: "muse.note-span.v1",
      sourcePath,
      sourceHash: seed.repeat(64),
      notesIndexSchema: 2,
      chunkerVersion: "muse.notes.chunk-text.v1",
      sourceIndexDigest: "b".repeat(64),
      chunkIndex: 0,
      chunkHash: "c".repeat(64),
      start: 0,
      end: 4,
      spanHash: "d".repeat(64)
    });
    const relation = {
      schema: "muse.note-relation.supersedes.v1",
      edgeId: "1".repeat(32),
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: identity("current.md", "a"),
      stale: identity("stale.md", "e")
    };
    await writeFile(paths.storeFile, `${JSON.stringify({
      schema: "muse.note-relations.store.v1",
      revision: 7,
      relations: [relation]
    })}\n`, { mode: 0o600 });
    const valid = await readNoteRelationsStore(paths);
    expect(valid).toMatchObject({ revision: 7, state: "valid" });
    expect(valid.relations).toEqual([relation]);
    expect(Object.isFrozen(valid.relations)).toBe(true);
    expect(Object.isFrozen(valid.relations[0])).toBe(true);

    for (const invalidRelation of [
      { ...relation, extra: true },
      { ...relation, edgeId: "A".repeat(32) },
      { ...relation, authoredAt: "2026-07-21" },
      { ...relation, current: { ...relation.current, sourcePath: "../outside.md" } },
      { ...relation, stale: { ...relation.stale, spanHash: "x".repeat(64) } }
    ]) {
      await writeFile(paths.storeFile, `${JSON.stringify({
        schema: "muse.note-relations.store.v1",
        revision: 7,
        relations: [invalidRelation]
      })}\n`, { mode: 0o600 });
      await expect(readNoteRelationsStore(paths)).rejects.toMatchObject({ code: "STORE_CORRUPT" });
    }
  });

  it("atomically serializes concurrent canonical mutations without losing an edge", async () => {
    const home = await mkdtemp(join(tmpdir(), "muse-note-relations-mutate-"));
    const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
    const first = storedRelation("1".repeat(32), "a");
    const second = storedRelation("2".repeat(32), "2");

    await Promise.all([
      mutateNoteRelationsStore(paths, (store) => [...store.relations, first]),
      mutateNoteRelationsStore(paths, (store) => [...store.relations, second])
    ]);

    const stored = await readNoteRelationsStore(paths);
    expect(stored).toMatchObject({ revision: 2, state: "valid" });
    expect(stored.relations.map((relation) => relation.edgeId)).toEqual([
      "1".repeat(32),
      "2".repeat(32)
    ]);
    expect((await lstat(paths.storeFile)).mode & 0o777).toBe(0o600);
    await expect(lstat(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(paths.storeFile, "utf8")).endsWith("\n")).toBe(true);
  });
});
