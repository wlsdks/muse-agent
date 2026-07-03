import { promises as fsPromises } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadIndex, NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";

describe("loadIndex — version-mismatch backup (DS-20: even a rebuildable cache should never silently overwrite its source without a trace)", () => {
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

  it("preserves the original file's content at a backup path before falling back to undefined", async () => {
    const raw = JSON.stringify(mismatchedPayload);
    await writeFile(file, raw);
    await loadIndex(file);
    const entries = await readdir(dir);
    const backupName = entries.find((name) => name.startsWith("notes-index.json.bak-v999-"));
    expect(backupName).toBeDefined();
    const backedUp = await readFile(join(dir, backupName!), "utf8");
    expect(backedUp).toBe(raw);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("does NOT create a backup when the version matches (regression guard — no behavior change on the healthy path)", async () => {
    await writeFile(file, JSON.stringify({ version: NOTES_INDEX_SCHEMA_VERSION, model: "m", builtAtIso: "x", files: [] }));
    const index = await loadIndex(file);
    expect(index).toBeDefined();
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes(".bak-"))).toBe(false);
  });

  it("a backup-rename failure is fail-soft — the read still returns undefined without throwing", async () => {
    await writeFile(file, JSON.stringify(mismatchedPayload));
    const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(loadIndex(file)).resolves.toBeUndefined();
    expect(renameSpy).toHaveBeenCalled();
  });
});
