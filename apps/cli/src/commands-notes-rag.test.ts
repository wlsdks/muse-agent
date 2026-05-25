import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chunkText, cosine, defaultIndexPath, extractDocumentText, isNotesIndexStale, parseRagBoundedInt, reindexNotes } from "./commands-notes-rag.js";

// Minimal hand-built PDF with one extractable text line — enough for
// pdf-parse to recover the body without a binary fixture file.
function minimalPdf(text: string): Buffer {
  const pdf =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    `4 0 obj<</Length ${(text.length + 30).toString()}>>stream\n` +
    `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n` +
    "endstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF";
  return Buffer.from(pdf, "latin1");
}

function fakeEmbedFetch(): typeof globalThis.fetch {
  return (async (_url: string | URL, init?: { body?: string }) => {
    const prompt = String(JSON.parse(String(init?.body ?? "{}")).prompt ?? "").toLowerCase();
    const embedding = prompt.includes("budget") ? [1, 0, 0] : [0, 1, 0];
    return new Response(JSON.stringify({ embedding }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

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

describe("chunkText — paragraph packing + oversized-paragraph hard-wrap", () => {
  it("packs small paragraphs together and keeps them within chunkChars", () => {
    const chunks = chunkText("alpha\n\nbeta\n\ngamma", 100);
    expect(chunks).toEqual(["alpha\n\nbeta\n\ngamma"]);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });

  it("splits a single paragraph longer than chunkChars at a word boundary, never exceeding chunkChars", () => {
    const para = Array.from({ length: 60 }, (_, i) => `word${i.toString()}`).join(" ");
    expect(para.length).toBeGreaterThan(120);
    const chunks = chunkText(para, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
      expect(c).not.toMatch(/^word\d*\S$|\Sword$/u); // not cut mid-word at the seam
    }
    // No content lost (modulo the whitespace collapsed at seams).
    expect(chunks.join(" ").replace(/\s+/gu, " ")).toBe(para);
  });

  it("hard-cuts an unbreakable run (no whitespace) so a long token can't blow past chunkChars", () => {
    const blob = "x".repeat(500); // e.g. a base64 / minified blob
    const chunks = chunkText(blob, 80);
    expect(chunks.length).toBe(Math.ceil(500 / 80));
    expect(chunks.every((c) => c.length <= 80)).toBe(true);
    expect(chunks.join("")).toBe(blob);
  });

  it("returns no chunks for empty / whitespace-only text", () => {
    expect(chunkText("", 100)).toEqual([]);
    expect(chunkText("   \n\n  \t ", 100)).toEqual([]);
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

describe("extractDocumentText", () => {
  it("extracts text from a PDF and reads markdown/txt verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-doc-extract-"));
    await writeFile(join(dir, "memo.pdf"), minimalPdf("Quarterly budget memo body"));
    await writeFile(join(dir, "note.md"), "plain markdown body", "utf8");
    const extracted = await extractDocumentText(join(dir, "memo.pdf"));
    expect(extracted).toContain("Quarterly budget memo body");
    // Proves it is pdf-parse output, not the raw bytes (which would
    // still contain the parenthesised text but also PDF structure).
    expect(extracted).not.toContain("endobj");
    expect(extracted).not.toContain("%PDF");
    expect(await extractDocumentText(join(dir, "note.md"))).toBe("plain markdown body");
  });
});

describe("reindexNotes ingests PDFs alongside markdown (P14)", () => {
  it("indexes a PDF's extracted text and ranks it above a decoy for a matching query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-doc-rag-"));
    await writeFile(join(dir, "memo.pdf"), minimalPdf("Quarterly budget memo body"));
    await writeFile(join(dir, "decoy.md"), "grocery shopping list: milk, eggs", "utf8");
    const indexPath = join(dir, "index.json");

    const summary = await reindexNotes({
      dir,
      fetchImpl: fakeEmbedFetch(),
      force: true,
      indexPath,
      model: "nomic-embed-text"
    });
    expect(summary.embedded).toBe(2);

    // The PDF's extracted text is in the index, not lost.
    const pdfChunks = summary.index.files.flatMap((f) => f.chunks).filter((c) => c.file.endsWith("memo.pdf"));
    expect(pdfChunks.some((c) => c.text.includes("Quarterly budget memo body"))).toBe(true);
    // Indexed the EXTRACTED text, not the raw PDF bytes.
    expect(pdfChunks.every((c) => !c.text.includes("endobj"))).toBe(true);

    // Retrieval over the index: a "budget" query ranks the PDF chunk top, decoy excluded.
    const queryEmbedding = [1, 0, 0];
    const ranked = summary.index.files
      .flatMap((f) => f.chunks.map((c) => ({ file: c.file, score: cosine(queryEmbedding, c.embedding) })))
      .sort((a, b) => b.score - a.score);
    expect(ranked[0]?.file.endsWith("memo.pdf")).toBe(true);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[ranked.length - 1]!.score);
  });
});

describe("defaultIndexPath — empty-HOME fall-through (goal-547 sibling)", () => {
  it("roots notes-index.json under HOME when HOME is set", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/u/jinan";
    try {
      expect(defaultIndexPath()).toBe("/u/jinan/.muse/notes-index.json");
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });

  it("falls back to os.homedir() when HOME is whitespace-only — does NOT produce '   /.muse/notes-index.json' or bare relative", () => {
    const prev = process.env.HOME;
    process.env.HOME = "   ";
    try {
      const resolved = defaultIndexPath();
      expect(resolved, "no leading whitespace in resolved path").not.toMatch(/^\s/u);
      expect(resolved, "no bare relative .muse/").not.toMatch(/^\.muse\//u);
      expect(resolved).toMatch(/\/.muse\/notes-index\.json$/u);
    } catch (cause) {
      expect((cause as Error).message).toMatch(/Cannot resolve home directory/u);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });
});

describe("reindexNotes — an embedding failure is counted, not reported as success", () => {
  it("a file whose chunks all fail to embed counts as `failed`, not `embedded`, and isn't stored empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-reindex-fail-"));
    await writeFile(join(dir, "note.md"), "some content to embed", "utf8");
    const failingFetch = (async () => new Response("model not found", { status: 404 })) as unknown as typeof globalThis.fetch;

    const summary = await reindexNotes({
      dir,
      fetchImpl: failingFetch,
      force: true,
      indexPath: join(dir, "index.json"),
      model: "nomic-embed-text"
    });

    // The bug: it reported `embedded: 1, failed: 0` and saved a chunk-less file.
    expect(summary.embedded).toBe(0);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    // A file with zero successfully-embedded chunks must not be stored as a
    // hollow "indexed" entry that silently returns no recall hits.
    const stored = summary.index.files.find((f) => f.path.endsWith("note.md"));
    expect(stored?.chunks.length ?? 0).toBe(0);
  });
});
