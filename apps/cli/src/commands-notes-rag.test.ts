import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cosine, isNotesIndexStale, parseRagBoundedInt } from "./commands-notes-rag.js";

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

describe("parseRagBoundedInt", () => {
  it("absent or empty falls back to the default", () => {
    expect(parseRagBoundedInt(undefined, "--top", 1, 50, 5)).toBe(5);
    expect(parseRagBoundedInt("   ", "--top", 1, 50, 5)).toBe(5);
  });

  it("truncates a genuine in-range number", () => {
    expect(parseRagBoundedInt("7.9", "--top", 1, 50, 5)).toBe(7);
    expect(parseRagBoundedInt("600", "--chunk-chars", 120, 8000, 600)).toBe(600);
  });

  it("clamps above max instead of rejecting (matches the strict line)", () => {
    expect(parseRagBoundedInt("999", "--top", 1, 50, 5)).toBe(50);
    expect(parseRagBoundedInt("999999999", "--chunk-chars", 120, 8000, 600)).toBe(8000);
  });

  it("rejects non-numeric, trailing-garbage, zero, negative, and below-min", () => {
    for (const bad of ["abc", "1O", "600x", "0", "-3"]) {
      expect(() => parseRagBoundedInt(bad, "--top", 1, 50, 5)).toThrow(/--top must be an integer in \[1, 50\]/u);
    }
    expect(() => parseRagBoundedInt("50", "--chunk-chars", 120, 8000, 600))
      .toThrow(/--chunk-chars must be an integer in \[120, 8000\]/u);
  });
});

describe("cosine — degenerate vectors and NaN values", () => {
  it("returns 0 when lengths differ", () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 when either vector is all zeros", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns a finite cosine for two clean vectors", () => {
    const result = cosine([1, 0, 0], [1, 0, 0]);
    expect(result).toBeCloseTo(1, 6);
  });

  it("returns 0 (not NaN) when either vector contains a NaN — protects the RAG render and sort from `[NaN]` scores", () => {
    expect(cosine([Number.NaN, 1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([1, 0, 0], [Number.NaN, 0, 0])).toBe(0);
  });
});
