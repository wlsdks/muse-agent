import { describe, expect, it } from "vitest";

import { extractDocumentText, isLikelyBinary, isPdfDocument, parsePdfBuffer } from "./document-reader.js";

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
