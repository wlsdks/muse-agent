import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isNotesIndexStale } from "./commands-notes-rag.js";

async function writeIndex(indexPath: string, files: { path: string; mtimeMs: number }[]): Promise<void> {
  const payload = {
    builtAtIso: new Date(0).toISOString(),
    files: files.map((f) => ({ chunks: [], mtimeMs: f.mtimeMs, path: f.path })),
    model: "nomic-embed-text",
    version: 1
  };
  await writeFile(indexPath, JSON.stringify(payload), "utf8");
}

describe("isNotesIndexStale", () => {
  it("returns true when the index file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-notes-rag-"));
    expect(await isNotesIndexStale(root, join(root, "nope-index.json"))).toBe(true);
  });

  it("returns true when an indexed file is rooted outside the current notes dir (wrong-corpus stale)", async () => {
    // Mirrors the dogfood bug: an earlier run built the index from
    // /tmp/.../notes/ and the index landed in ~/.muse/. A later run
    // with a different MUSE_NOTES_DIR loaded the stale index.
    const tmpRoot = await mkdtemp(join(tmpdir(), "muse-notes-rag-"));
    const otherCorpus = await mkdtemp(join(tmpdir(), "muse-other-corpus-"));
    const otherNotePath = join(otherCorpus, "note.md");
    await writeFile(otherNotePath, "# other\n", "utf8");
    const indexPath = join(tmpRoot, "notes-index.json");
    await writeIndex(indexPath, [{ mtimeMs: Date.now(), path: otherNotePath }]);
    // Current dir is tmpRoot (empty), index points at otherCorpus → stale.
    expect(await isNotesIndexStale(tmpRoot, indexPath)).toBe(true);
  });

  it("returns true when an indexed file path no longer exists on disk (ghost stale)", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-notes-rag-"));
    const indexPath = join(root, "notes-index.json");
    await writeIndex(indexPath, [{ mtimeMs: Date.now(), path: join(root, "gone.md") }]);
    expect(await isNotesIndexStale(root, indexPath)).toBe(true);
  });

  it("returns false when every indexed file is inside the dir, exists, and is not newer than the build", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-notes-rag-"));
    const indexPath = join(root, "notes-index.json");
    const notePath = join(root, "kept.md");
    await writeFile(notePath, "# kept\n", "utf8");
    // mtimeMs older than now (index built at epoch 0 in this fixture
    // would actually be older than the file, so we explicitly pick a
    // post-now build time).
    const payload = {
      builtAtIso: new Date(Date.now() + 60_000).toISOString(),
      files: [{ chunks: [], mtimeMs: Date.now() - 60_000, path: notePath }],
      model: "nomic-embed-text",
      version: 1
    };
    await writeFile(indexPath, JSON.stringify(payload), "utf8");
    expect(await isNotesIndexStale(root, indexPath)).toBe(false);
  });
});
