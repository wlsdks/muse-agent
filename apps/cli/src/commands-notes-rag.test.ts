import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chunkText, cosine, defaultIndexPath, extractDocumentText, formatNoteFolders, formatRecentNotes, formatRelatedNotes, formatRelativeAge, isNotesIndexStale, NOTE_FILE_RE, parseRagBoundedInt, rankRelatedNotes, reindexNotes, resolveIndexNotePath, selectRecentNotes, summarizeNoteFolders } from "./commands-notes-rag.js";

describe("summarizeNoteFolders — group notes by top-level collection + last activity", () => {
  const DAY = 86_400_000;
  const now = 2_000_000_000_000; // a fixed reference
  const files = [
    { path: "/notes/work/q3.md", mtimeMs: now - 2 * DAY },
    { path: "/notes/work/standup.md", mtimeMs: now - 100 * DAY },
    { path: "/notes/work/sub/deep.md", mtimeMs: now - 1 * DAY }, // still "work" (top-level)
    { path: "/notes/personal/diary.md", mtimeMs: now - 5 * DAY },
    { path: "/notes/inbox.md", mtimeMs: now - 3 * DAY } // root-level → "(root)"
  ];

  it("groups by the TOP-LEVEL folder, counts, and tracks newest/oldest", () => {
    const out = summarizeNoteFolders(files, "/notes");
    expect(out.map((f) => [f.folder, f.count])).toEqual([["work", 3], ["(root)", 1], ["personal", 1]]); // count desc, then name
    const work = out.find((f) => f.folder === "work")!;
    expect(work.newestMs).toBe(now - 1 * DAY);   // the deep sub-note is the most recent
    expect(work.oldestMs).toBe(now - 100 * DAY);
  });

  it("returns [] for an empty corpus", () => {
    expect(summarizeNoteFolders([], "/notes")).toEqual([]);
  });
});

describe("formatNoteFolders — readable collection overview, flags cold folders", () => {
  const now = new Date("2026-06-05T12:00:00Z");
  const ms = (days: number): number => now.getTime() - days * 86_400_000;

  it("lists folders with counts + last-activity, flagging a collection gone cold (>90d)", () => {
    const out = formatNoteFolders([
      { folder: "work", count: 12, newestMs: ms(2), oldestMs: ms(300) },
      { folder: "aurora", count: 4, newestMs: ms(120), oldestMs: ms(200) } // cold
    ], now);
    expect(out).toContain("📁 Your note collections (2 folders, 16 notes):");
    expect(out).toMatch(/work\s+12 notes\s+last edit 2d ago/u);
    expect(out).toContain("⚠ gone cold"); // aurora's newest is 120d old
    expect(out).not.toMatch(/work.*gone cold/u); // work is fresh
  });

  it("singularizes the total-notes count when there is exactly one note", () => {
    const out = formatNoteFolders([{ folder: "inbox", count: 1, newestMs: ms(1), oldestMs: ms(1) }], now);
    expect(out).toContain("📁 Your note collection (1 folder, 1 note):");
    expect(out).not.toContain("1 notes");
  });

  it("handles the empty case", () => {
    expect(formatNoteFolders([], now)).toContain("No notes yet");
  });
});

describe("NOTE_FILE_RE — the corpus indexes prose formats beyond .md/.txt", () => {
  it("matches markdown + plain-text + markup note formats (so org/rst/mdx notes aren't invisible)", () => {
    for (const name of ["a.md", "a.markdown", "a.mkd", "a.mdown", "a.mdx", "a.txt", "a.text", "a.org", "a.rst", "a.adoc", "a.asciidoc", "a.pdf", "A.ORG", "deep/path/note.org"]) {
      expect(NOTE_FILE_RE.test(name)).toBe(true);
    }
  });

  it("does NOT match binary / data / non-note formats", () => {
    for (const name of ["a.png", "a.json", "a.csv", "a.docx", "a.xlsx", "a.zip", "a.js", "a", "a.orgx", "note.md.bak"]) {
      expect(NOTE_FILE_RE.test(name)).toBe(false);
    }
  });
});

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

  it("default (no overlap arg) is byte-identical to the prior behaviour — back-compat", () => {
    const text = ["alpha\n\nbeta\n\ngamma", "x".repeat(500), Array.from({ length: 60 }, (_v, i) => `w${i.toString()}`).join(" ")].join("\n\n");
    expect(chunkText(text, 80)).toEqual(chunkText(text, 80, 0));
  });

  it("overlap keeps the two halves of a boundary-spanning fact in one chunk (notes-index recall)", () => {
    const head = `${"alpha ".repeat(8).trim()} RECONCILE`;
    const tail = `budget cap ${"beta ".repeat(8).trim()}`;
    const text = `${head}\n\n${tail}`;
    expect(chunkText(text, 60).some((c) => c.includes("RECONCILE") && c.includes("budget cap"))).toBe(false);
    expect(chunkText(text, 60, 25).some((c) => c.includes("RECONCILE") && c.includes("budget cap"))).toBe(true);
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

describe("reindexNotes — a corrupt document is skipped VISIBLY, not silently (partial-failure tolerance)", () => {
  it("emits a progress skip line for an unreadable PDF and still ingests the good note, without aborting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-reindex-skip-"));
    await writeFile(join(dir, "good.md"), "the WireGuard MTU is 1380", "utf8");
    // A `%PDF-` header with garbage body → pdf-parse throws "Invalid PDF
    // structure", exercising the extract-failure catch (a real corrupt download).
    await writeFile(join(dir, "corrupt.pdf"), Buffer.from("%PDF-1.7\nthis is not a valid pdf at all\n"));
    const progress: string[] = [];

    const summary = await reindexNotes({
      dir,
      fetchImpl: fakeEmbedFetch(),
      force: true,
      indexPath: join(dir, "index.json"),
      model: "nomic-embed-text",
      onProgress: (line) => progress.push(line)
    });

    // Partial-failure tolerance: the good note ingested, the run did NOT abort.
    expect(summary.embedded).toBe(1);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.index.files.some((f) => f.path.endsWith("good.md"))).toBe(true);
    // The corrupt file is not stored as a hollow entry.
    expect(summary.index.files.some((f) => f.path.endsWith("corrupt.pdf"))).toBe(false);
    // VISIBILITY: the skip is reported via onProgress, not swallowed.
    expect(progress.some((l) => l.startsWith("✗") && l.includes("corrupt.pdf") && /could not read/.test(l))).toBe(true);
    expect(progress.some((l) => l.startsWith("+") && l.includes("good.md"))).toBe(true);
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

describe("muse notes recent — resume where you left off (newest-first)", () => {
  it("selectRecentNotes sorts by mtime DESC and caps at the limit", () => {
    const files = [
      { mtimeMs: 1000, path: "/n/old.md" },
      { mtimeMs: 5000, path: "/n/newest.md" },
      { mtimeMs: 3000, path: "/n/mid.md" }
    ];
    expect(selectRecentNotes(files, 2).map((f) => f.path)).toEqual(["/n/newest.md", "/n/mid.md"]);
    expect(selectRecentNotes(files).map((f) => f.path)).toEqual(["/n/newest.md", "/n/mid.md", "/n/old.md"]);
    expect(selectRecentNotes(files, 0).length).toBe(1); // limit floors at 1
  });

  it("formatRelativeAge renders coarse past ages", () => {
    expect(formatRelativeAge(20_000)).toBe("just now"); // <1 min
    expect(formatRelativeAge(12 * 60_000)).toBe("12m ago");
    expect(formatRelativeAge(3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeAge(2 * 86_400_000)).toBe("2d ago");
  });

  it("formatRecentNotes renders the relative age + path, and guides when empty", () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const out = formatRecentNotes([
      { mtimeMs: Date.parse("2026-05-18T10:00:00.000Z"), path: "/notes/project/plan.md" },
      { mtimeMs: Date.parse("2026-05-16T12:00:00.000Z"), path: "/notes/budget.md" }
    ], "/notes", now);
    expect(out).toContain("📝 Recently edited:");
    expect(out).toContain("2h ago — project/plan.md");
    expect(out).toContain("2d ago — budget.md");
    expect(formatRecentNotes([], "/notes", now)).toContain("No notes yet");
  });
});

describe("muse notes related — semantic note discovery (embedding similarity)", () => {
  const chunk = (file: string, embedding: number[]) => ({ chunkIndex: 0, embedding, file, text: "x" });
  const index = {
    builtAtIso: "2026-06-01T00:00:00.000Z",
    files: [
      { chunks: [chunk("a.md", [1, 0, 0])], mtimeMs: 1, path: "/notes/a.md" },
      { chunks: [chunk("b.md", [0.8, 0.2, 0])], mtimeMs: 2, path: "/notes/b.md" }, // close to a
      { chunks: [chunk("c.md", [0, 1, 0])], mtimeMs: 3, path: "/notes/c.md" },     // orthogonal → cosine 0, filtered
      { chunks: [chunk("d.md", [0.5, 0.5, 0])], mtimeMs: 4, path: "/notes/d.md" }  // medium
    ],
    model: "nomic-embed-text",
    version: 1 as const
  };

  it("ranks notes by centroid cosine, excludes the target and zero-overlap notes", () => {
    const related = rankRelatedNotes(index, "/notes/a.md");
    expect(related.map((r) => r.path)).toEqual(["/notes/b.md", "/notes/d.md"]); // b closer than d, c (cos 0) dropped, a excluded
    expect(related[0]!.score).toBeGreaterThan(related[1]!.score);
  });

  it("honours the limit and returns [] for an unknown / chunkless target", () => {
    expect(rankRelatedNotes(index, "/notes/a.md", 1).map((r) => r.path)).toEqual(["/notes/b.md"]);
    expect(rankRelatedNotes(index, "/notes/missing.md")).toEqual([]);
  });

  it("resolveIndexNotePath matches exact path, basename stem, and a unique substring", () => {
    expect(resolveIndexNotePath(index, "/notes/a.md")).toBe("/notes/a.md");
    expect(resolveIndexNotePath(index, "b")).toBe("/notes/b.md");      // stem
    expect(resolveIndexNotePath(index, "B.MD")).toBe("/notes/b.md");   // case-insensitive stem
    expect(resolveIndexNotePath(index, "zzz")).toBeUndefined();        // no match
  });

  it("formatRelatedNotes renders a % score + relative path, and an empty-state line", () => {
    const out = formatRelatedNotes("/notes/a.md", [{ path: "/notes/b.md", score: 0.97 }], "/notes");
    expect(out).toContain("🔗 Notes related to 'a.md':");
    expect(out).toContain("97%");
    expect(out).toContain("b.md");
    expect(formatRelatedNotes("/notes/a.md", [], "/notes")).toContain("stands alone");
  });
});
