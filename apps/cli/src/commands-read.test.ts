import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDirNotesProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDocumentNoteBody, ensureNoteMarkdownExtension, extractDocumentText, ingestDirectoryToNotes, isLikelyBinary, isPdfDocument, noteIdForDocument, saveDocumentToNotes } from "./commands-read.js";

// A telegram-bot-token shaped secret (redactSecretsInText scrubs it).
const SECRET = `123456:${"A".repeat(35)}`;

describe("buildDocumentNoteBody — ingested-document note", () => {
  it("titles by the source filename and records the source + page count", () => {
    const { title, body } = buildDocumentNoteBody("/docs/lease.pdf", "the rent is due on the 1st", 3);
    expect(title).toBe("Document — lease.pdf");
    expect(body).toContain("Source: /docs/lease.pdf (3 pages)");
    expect(body).toContain("the rent is due on the 1st");
  });

  it("uses the singular 'page' for a one-page document", () => {
    expect(buildDocumentNoteBody("/x.pdf", "hi", 1).body).toContain("(1 page)");
  });

  it("scrubs secrets out of the persisted text (a note is long-lived)", () => {
    const body = buildDocumentNoteBody("/x.pdf", `key ${SECRET} end`, 1).body;
    expect(body).not.toContain(SECRET);
    expect(body).toContain("[redacted-telegram-bot-token]");
  });
});

describe("saveDocumentToNotes — ingests a document into the searchable notes store", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-read-save-")); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("writes a note that LocalDirNotesProvider can read back (so knowledge_search will find it)", async () => {
    await saveDocumentToNotes(dir, "lease.md", "/docs/lease.pdf", "the rent is due on the 1st of each month", 2);
    const note = await new LocalDirNotesProvider({ notesDir: dir }).read("lease.md");
    expect(note).toBeDefined();
    expect(note!.body).toContain("the rent is due on the 1st of each month");
    expect(note!.body).toContain("Source: /docs/lease.pdf (2 pages)");
  });
});

describe("extractDocumentText — PDF or text, reject binary", () => {
  it("reads a plain-text file as UTF-8, one page", async () => {
    const parsed = await extractDocumentText("/notes/meeting.txt", Buffer.from("the deadline is Friday\n", "utf8"));
    expect(parsed.text).toContain("the deadline is Friday");
    expect(parsed.pageCount).toBe(1);
  });

  it("reads markdown / log / csv text files too", async () => {
    expect((await extractDocumentText("/x.md", Buffer.from("# Title\nbody", "utf8"))).text).toContain("# Title");
    expect((await extractDocumentText("/server.log", Buffer.from("ERROR boom", "utf8"))).text).toContain("ERROR boom");
  });

  it("rejects a binary file (NUL byte) with a clear error — no garbage dump", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    await expect(extractDocumentText("/photo.png", png)).rejects.toThrow("looks binary");
  });

  it("isPdfDocument detects by extension or %PDF- magic", () => {
    expect(isPdfDocument("/x.pdf", Buffer.from("anything"))).toBe(true);
    expect(isPdfDocument("/x.bin", Buffer.from("%PDF-1.7 ...", "latin1"))).toBe(true);
    expect(isPdfDocument("/x.txt", Buffer.from("hello", "utf8"))).toBe(false);
  });

  it("isLikelyBinary flags a NUL byte, passes clean text", () => {
    expect(isLikelyBinary(Buffer.from([0x68, 0x69, 0x00]))).toBe(true);
    expect(isLikelyBinary(Buffer.from("hello world", "utf8"))).toBe(false);
  });
});

describe("ingestDirectoryToNotes — bulk folder ingest into the corpus (partial-failure tolerant)", () => {
  it("ingests every supported doc, skips a corrupt one VISIBLY, and writes citable notes under the prefix", async () => {
    const src = await mkdtemp(join(tmpdir(), "muse-bulk-src-"));
    const notesDir = await mkdtemp(join(tmpdir(), "muse-bulk-notes-"));
    try {
      await writeFile(join(src, "vpn.txt"), "WireGuard VPN MTU is 1380", "utf8");
      await mkdir(join(src, "sub"), { recursive: true });
      await writeFile(join(src, "sub", "rent.md"), "rent is due on the 25th, $1450", "utf8");
      await writeFile(join(src, "corrupt.pdf"), Buffer.from("%PDF-1.7\nnot a real pdf\n"));
      await writeFile(join(src, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])); // binary, unsupported ext → not walked
      const progress: string[] = [];

      const summary = await ingestDirectoryToNotes(src, notesDir, "downloads", (l) => progress.push(l));

      // png is not a supported doc ext, so total counts only the 3 doc files.
      expect(summary.total).toBe(3);
      expect(summary.ingested).toBe(2);
      expect(summary.skipped).toBe(1);
      // The good docs are saved as citable .md notes under the prefix (subdir
      // preserved); the .md extension is required for the notes-index walker.
      const provider = new LocalDirNotesProvider({ notesDir });
      expect((await provider.read("downloads/vpn.md"))?.body).toContain("1380");
      expect((await provider.read("downloads/sub/rent.md"))?.body).toContain("$1450");
      // Partial failure is VISIBLE, not swallowed; the run did not abort.
      expect(progress.some((l) => l.startsWith("✗") && l.includes("corrupt.pdf"))).toBe(true);
      expect(progress.some((l) => l.startsWith("+") && l.includes("vpn.txt"))).toBe(true);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(notesDir, { recursive: true, force: true });
    }
  });

  it("noteIdForDocument strips the extension, preserves subdirs, applies the prefix", () => {
    expect(noteIdForDocument("/c", "/c/a.txt", "downloads")).toBe("downloads/a");
    expect(noteIdForDocument("/c", "/c/sub/b.pdf", "downloads")).toBe("downloads/sub/b");
    expect(noteIdForDocument("/c", "/c/a.txt", "")).toBe("a");
  });
});

describe("ensureNoteMarkdownExtension — a saved note must be indexable by `muse ask`", () => {
  it("appends .md to a bare/extensionless id (the false-'searchable' bug fix)", () => {
    expect(ensureNoteMarkdownExtension("garage")).toBe("garage.md");
    expect(ensureNoteMarkdownExtension("downloads/manuals/trip")).toBe("downloads/manuals/trip.md");
  });

  it("leaves an already-indexable extension untouched (no double extension)", () => {
    expect(ensureNoteMarkdownExtension("note.md")).toBe("note.md");
    expect(ensureNoteMarkdownExtension("vault/a.markdown")).toBe("vault/a.markdown");
    expect(ensureNoteMarkdownExtension("log/b.txt")).toBe("log/b.txt");
  });

  it("a single-file `--save-to-notes <bareId>` save is now read back as a .md note", async () => {
    const notesDir = await mkdtemp(join(tmpdir(), "muse-single-md-"));
    try {
      await saveDocumentToNotes(notesDir, ensureNoteMarkdownExtension("garage"), "/src/garage.txt", "code 7731", 1);
      const provider = new LocalDirNotesProvider({ notesDir });
      expect((await provider.read("garage.md"))?.body).toContain("7731");
    } finally {
      await rm(notesDir, { recursive: true, force: true });
    }
  });
});
