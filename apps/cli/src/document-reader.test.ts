import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractDirectoryDocuments, extractDocumentText, isLikelyBinary, isPdfDocument, parsePdfBuffer, walkDocuments } from "./document-reader.js";

/** Build a tiny but VALID single-page PDF whose text layer contains `text`. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("isPdfDocument", () => {
  it("detects a PDF by .pdf extension or %PDF- magic header", () => {
    expect(isPdfDocument("/x.pdf", Buffer.from("anything"))).toBe(true);
    expect(isPdfDocument("/x.bin", Buffer.from("%PDF-1.7 ...", "latin1"))).toBe(true);
    expect(isPdfDocument("/x.txt", Buffer.from("plain text"))).toBe(false);
  });
});

describe("isLikelyBinary", () => {
  it("flags a NUL byte as binary and leaves clean text alone", () => {
    expect(isLikelyBinary(Buffer.from([0x48, 0x00, 0x49]))).toBe(true);
    expect(isLikelyBinary(Buffer.from("just normal text\n"))).toBe(false);
  });
});

describe("parsePdfBuffer — real pdf-parse extraction", () => {
  it("extracts the text layer of a valid PDF", async () => {
    const parsed = await parsePdfBuffer(makePdf("Job title: Staff Data Scientist at Acme Corp"));
    expect(parsed.text).toContain("Staff Data Scientist at Acme Corp");
    expect(parsed.pageCount).toBeGreaterThanOrEqual(1);
  });
});

describe("extractDocumentText", () => {
  it("reads a PDF's text via pdf-parse", async () => {
    const out = await extractDocumentText("/resume.pdf", makePdf("Senior Engineer since 2021"));
    expect(out.text).toContain("Senior Engineer since 2021");
  });

  it("reads a plain text/markdown file verbatim as one page", async () => {
    const out = await extractDocumentText("/notes.md", Buffer.from("# Title\nThe code is alpha-niner.\n"));
    expect(out.text).toContain("alpha-niner");
    expect(out.pageCount).toBe(1);
  });

  it("throws on a non-PDF binary so the caller never grounds on garbage", async () => {
    await expect(extractDocumentText("/photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff])))
      .rejects.toThrow(/binary/);
  });
});

describe("walkDocuments + extractDirectoryDocuments — `--file <dir>` grounding source", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-docdir-"));
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "budget.txt"), "The Q3 budget is $42,000.\n");
    await writeFile(join(dir, "launch.md"), "Launch on August 14.\n");
    await writeFile(join(dir, "sub", "notes.log"), "nested log line\n");
    await writeFile(join(dir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff])); // binary, skipped
    await writeFile(join(dir, "archive.zip"), "ignored extension\n"); // unsupported ext
    await writeFile(join(dir, ".hidden.txt"), "hidden, skipped\n"); // dotfile
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("walks only the supported text/PDF extensions, recursively, skipping dotfiles", async () => {
    const found = (await walkDocuments(dir)).map((p) => p.replace(`${dir}/`, ""));
    expect(found).toContain("budget.txt");
    expect(found).toContain("launch.md");
    expect(found).toContain("sub/notes.log");
    expect(found).not.toContain("archive.zip");      // unsupported extension
    expect(found).not.toContain(".hidden.txt");       // dotfile
  });

  it("extracts text from every readable doc and SKIPS the binary one (no garbage)", async () => {
    const docs = await extractDirectoryDocuments(dir);
    const byName = Object.fromEntries(docs.map((d) => [d.path.replace(`${dir}/`, ""), d.text]));
    expect(byName["budget.txt"]).toContain("$42,000");
    expect(byName["launch.md"]).toContain("August 14");
    expect(byName["sub/notes.log"]).toContain("nested log");
    expect(Object.keys(byName)).not.toContain("photo.png"); // binary skipped, not garbage
  });

  it("respects the maxFiles cap", async () => {
    const docs = await extractDirectoryDocuments(dir, 1);
    expect(docs.length).toBe(1);
  });
});
