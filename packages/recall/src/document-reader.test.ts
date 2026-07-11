import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOTE_FILE_RE } from "./notes-index.js";
import { SUPPORTED_DOC_EXT, docxToText, emlToText, extractDirectoryDocuments, extractDocumentText, formatDirectoryCapNotice, formatUrlTruncationNotice, htmlToText, isDocxDocument, isEmlDocument, isHtmlDocument, isLikelyBinary, isPdfDocument, isPptxDocument, parsePdfBuffer, pptxToText, walkDocuments } from "./document-reader.js";

/** Build a minimal but spec-valid ZIP (local headers + central directory + EOCD),
 *  so the .docx tests exercise the REAL inflate path, not a stub. CRC is left 0 —
 *  the reader (and zlib inflate) don't verify it. */
function makeZip(entries: readonly { readonly name: string; readonly data: Buffer; readonly store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.store ? 0 : 8;
    const comp = e.store ? e.data : deflateRawSync(e.data);
    const nameBuf = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localRec = Buffer.concat([local, nameBuf, comp]);
    locals.push(localRec);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localRec.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

/** A real .docx: the body paragraphs as `<w:t>` runs inside word/document.xml,
 *  preceded by a [Content_Types].xml entry (so document.xml isn't the first entry —
 *  proving the reader finds it by name, not position). */
function makeDocx(paragraphs: readonly string[], opts?: { readonly store?: boolean }): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
    { name: "word/document.xml", data: Buffer.from(xml, "utf8"), store: opts?.store }
  ]);
}

/** A real .pptx: one `ppt/slides/slideN.xml` per slide, each slide's lines as
 *  `<a:t>` runs. Entries are intentionally added out of slide order to prove the
 *  reader sorts by slide number, not archive position. */
function makePptx(slides: readonly (readonly string[])[]): Buffer {
  const slideEntries = slides.map((lines, i) => {
    const body = lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
    return { name: `ppt/slides/slide${(i + 1).toString()}.xml`, data: Buffer.from(xml, "utf8") };
  });
  return makeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
    ...[...slideEntries].reverse() // out of order on purpose
  ]);
}

const SAMPLE_EML = [
  "From: Jane Park <jane@globex.com>",
  "To: me@example.com",
  "Subject: =?UTF-8?B?UTMgYnVkZ2V0IOKAlCByZXZpZXc=?=",
  "Date: Tue, 03 Jun 2026 09:00:00 +0000",
  "Content-Type: multipart/alternative; boundary=\"BNDRY\"",
  "",
  "--BNDRY",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hi, the Q3 budget needs to drop by 5=25 before Friday. Can=",
  " you confirm the headcount=3F",
  "--BNDRY",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<p>ignored html part</p>",
  "--BNDRY--"
].join("\r\n");

describe("isEmlDocument / emlToText — ground a saved email on its message, not raw MIME", () => {
  it("recognises only .eml by extension", () => {
    expect(isEmlDocument("/x/message.eml")).toBe(true);
    expect(isEmlDocument("/x/MESSAGE.EML")).toBe(true);
    expect(isEmlDocument("/x/notes.txt")).toBe(false);
  });

  it("decodes the encoded-word subject, picks the text/plain part, and unwinds quoted-printable", () => {
    const text = emlToText(SAMPLE_EML);
    expect(text).toContain("Subject: Q3 budget — review"); // =?UTF-8?B?…?= decoded
    expect(text).toContain("From: Jane Park <jane@globex.com>");
    expect(text).toContain("the Q3 budget needs to drop by 5% before Friday"); // 5=25 → 5%, soft break joined
    expect(text).toContain("confirm the headcount?"); // =3F → ?
    expect(text).not.toContain("ignored html part"); // the text/plain part wins over text/html
    expect(text).not.toContain("=3F"); // raw QP gone
  });

  it("extractDocumentText routes a .eml through the MIME parser (one page of clean text)", async () => {
    const parsed = await extractDocumentText("/x/message.eml", Buffer.from(SAMPLE_EML, "utf8"));
    expect(parsed.pageCount).toBe(1);
    expect(parsed.text).toContain("Q3 budget");
    expect(parsed.text).not.toContain("Content-Transfer-Encoding");
  });
});

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
    // Non-markdown PROSE notes the index already perceives — must NOT be
    // silently skipped by folder grounding/ingest anymore.
    await writeFile(join(dir, "design.org"), "* Design\nThe API rate limit is 90 req/s.\n");
    await writeFile(join(dir, "manual.rst"), "Manual\n======\nThe serial port runs at 115200 baud.\n");
    await writeFile(join(dir, "guide.adoc"), "= Guide\nThe default timeout is 30 seconds.\n");
    await writeFile(join(dir, "spec.mdx"), "# Spec\nThe webhook secret rotates monthly.\n");
    await writeFile(join(dir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff])); // binary, skipped
    await writeFile(join(dir, "archive.zip"), "ignored extension\n"); // unsupported ext
    await writeFile(join(dir, ".hidden.txt"), "hidden, skipped\n"); // dotfile
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("walks the supported text/PDF/prose extensions, recursively, skipping dotfiles + unsupported", async () => {
    const found = (await walkDocuments(dir)).map((p) => p.slice(dir.length + 1).replaceAll("\\", "/"));
    expect(found).toContain("budget.txt");
    expect(found).toContain("launch.md");
    expect(found).toContain("sub/notes.log");
    // The non-markdown prose notes are now collected (the gap this slice closed):
    expect(found).toContain("design.org");
    expect(found).toContain("manual.rst");
    expect(found).toContain("guide.adoc");
    expect(found).toContain("spec.mdx");
    expect(found).not.toContain("archive.zip");      // unsupported extension
    expect(found).not.toContain(".hidden.txt");       // dotfile
  });

  it("extracts text from every readable doc (incl. .org/.rst/.adoc/.mdx) and SKIPS the binary one", async () => {
    const { documents: docs } = await extractDirectoryDocuments(dir);
    const byName = Object.fromEntries(docs.map((d) => [d.path.slice(dir.length + 1).replaceAll("\\", "/"), d.text]));
    expect(byName["budget.txt"]).toContain("$42,000");
    expect(byName["launch.md"]).toContain("August 14");
    expect(byName["sub/notes.log"]).toContain("nested log");
    expect(byName["design.org"]).toContain("90 req/s");
    expect(byName["manual.rst"]).toContain("115200 baud");
    expect(byName["guide.adoc"]).toContain("30 seconds");
    expect(byName["spec.mdx"]).toContain("rotates monthly");
    expect(Object.keys(byName)).not.toContain("photo.png"); // binary skipped, not garbage
  });

  it("respects the maxFiles cap AND reports the total found so a truncated folder isn't silent", async () => {
    const result = await extractDirectoryDocuments(dir, 1);
    expect(result.documents.length).toBe(1); // only 1 read
    expect(result.cap).toBe(1);
    expect(result.totalFound).toBeGreaterThan(1); // the folder has more — caller can warn
  });

  // Drift guard: every PROSE format the notes index perceives (NOTE_FILE_RE)
  // must also be folder-groundable, else `muse ask --file <dir>` / `muse read
  // <dir>` silently skip notes the index includes — the inconsistency this slice
  // closed. (The reader carries a few extra document types of its own, which is
  // fine — this only asserts the reader is a SUPERSET of the index's notes.)
  it("SUPPORTED_DOC_EXT covers every prose format the notes index (NOTE_FILE_RE) perceives", () => {
    for (const ext of ["md", "markdown", "mkd", "mdown", "mdx", "txt", "text", "org", "rst", "adoc", "asciidoc", "pdf"]) {
      expect(NOTE_FILE_RE.test(`note.${ext}`)).toBe(true); // sanity: this IS a note format
      expect(SUPPORTED_DOC_EXT.has(`.${ext}`)).toBe(true); // ...and the folder walk collects it
    }
  });
});

describe("htmlToText + isHtmlDocument — read an HTML file's readable text, not tag-soup", () => {
  it("isHtmlDocument matches .html/.htm, not other text", () => {
    expect(isHtmlDocument("/resume.html")).toBe(true);
    expect(isHtmlDocument("/page.HTM")).toBe(true);
    expect(isHtmlDocument("/notes.txt")).toBe(false);
  });

  it("strips tags, drops <script>/<style> bodies, and collapses whitespace", () => {
    const text = htmlToText("<html><head><style>body{color:red}</style><script>track(1)</script></head><body><h1>Jane</h1>\n<p>Hi  there</p></body></html>");
    expect(text).toBe("Jane Hi there");
    expect(text).not.toMatch(/track|color:red|</);
  });

  it("decodes the entities that mangle grounded values (numeric, hex, named)", () => {
    expect(htmlToText("<p>jane&#64;globex.com</p>")).toBe("jane@globex.com");      // &#64; → @
    expect(htmlToText("<p>a&#x26;b</p>")).toBe("a&b");                              // hex &#x26; → &
    expect(htmlToText("<p>Globex &amp; Co &mdash; 2026</p>")).toBe("Globex & Co — 2026");
  });

  it("extractDocumentText reads an .html buffer as decoded text", async () => {
    const out = await extractDocumentText("/r.html", Buffer.from("<body><p>Email: a&#64;b.com</p></body>"));
    expect(out.text).toContain("a@b.com");
    expect(out.text).not.toContain("<");
  });
});

describe("formatDirectoryCapNotice — be honest when a big --file <dir> was truncated", () => {
  it("is empty when nothing was dropped (read everything)", () => {
    expect(formatDirectoryCapNotice("/notes", 10, 25)).toBe("");
    expect(formatDirectoryCapNotice("/notes", 25, 25)).toBe(""); // exactly at the cap, none dropped
  });

  it("names the total, the cap, and how many were NOT read", () => {
    const notice = formatDirectoryCapNotice("/big-folder", 50, 25);
    expect(notice).toContain("/big-folder has 50 documents");
    expect(notice).toContain("first 25 only");
    expect(notice).toContain("other 25 were NOT read");
  });
})

describe("formatUrlTruncationNotice — be honest when a long --url page was capped", () => {
  it("names the source, the char cap (grouped), and that the rest was NOT read", () => {
    const notice = formatUrlTruncationNotice("en.wikipedia.org", 60_000);
    expect(notice).toContain("en.wikipedia.org is long");
    expect(notice).toContain("first 60,000 characters");
    expect(notice).toContain("NOT read");
    expect(notice).toContain("specific section");
  });
})

describe("isDocxDocument / docxToText — ground a Word .docx on its body text", () => {
  it("recognises only .docx by extension", () => {
    expect(isDocxDocument("/x/resume.docx")).toBe(true);
    expect(isDocxDocument("/x/RESUME.DOCX")).toBe(true);
    expect(isDocxDocument("/x/notes.txt")).toBe(false);
    expect(isDocxDocument("/x/sheet.xlsx")).toBe(false);
  });

  it("extracts the paragraph text from a real (deflate-compressed) .docx, one paragraph per line", () => {
    const text = docxToText(makeDocx(["Senior Engineer since 2021.", "Skills: TypeScript, Rust."]), "/x/resume.docx");
    expect(text).toBe("Senior Engineer since 2021.\nSkills: TypeScript, Rust.");
  });

  it("handles a STORED (uncompressed) entry and decodes XML entities", () => {
    expect(docxToText(makeDocx(["Tom &amp; Jerry &lt;tagged&gt;"], { store: true }))).toBe("Tom & Jerry <tagged>");
  });

  it("routes a .docx through extractDocumentText as one page — even though its bytes ARE a binary ZIP", async () => {
    const buf = makeDocx(["The launch is on August 14."]);
    expect(isLikelyBinary(buf)).toBe(true); // a ZIP has NUL bytes — must not be refused
    const parsed = await extractDocumentText("/x/plan.docx", buf);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.text).toContain("August 14");
  });

  it("throws on a ZIP with no word/document.xml (not a real .docx)", () => {
    const notDocx = makeZip([{ name: "other.xml", data: Buffer.from("<x/>", "utf8") }]);
    expect(() => docxToText(notDocx, "/x/fake.docx")).toThrow(/readable \.docx/u);
  });

  it("the folder walk collects .docx alongside the other reader formats", async () => {
    expect(SUPPORTED_DOC_EXT.has(".docx")).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "muse-docx-"));
    try {
      await writeFile(join(dir, "brief.docx"), makeDocx(["Quarterly target is 40 units."]));
      const found = await walkDocuments(dir);
      expect(found.map((f) => f.endsWith("brief.docx"))).toContain(true);
      const { documents } = await extractDirectoryDocuments(dir);
      expect(documents.find((d) => d.path.endsWith("brief.docx"))?.text).toContain("40 units");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
})

describe("isPptxDocument / pptxToText — ground a PowerPoint .pptx on its slide text", () => {
  it("recognises only .pptx by extension", () => {
    expect(isPptxDocument("/x/deck.pptx")).toBe(true);
    expect(isPptxDocument("/x/DECK.PPTX")).toBe(true);
    expect(isPptxDocument("/x/notes.docx")).toBe(false);
  });

  it("extracts every slide's text in slide-number order (not archive order)", () => {
    const text = pptxToText(makePptx([
      ["Roadmap 2027", "Theme: reliability"],
      ["Q1: ship the daemon"],
      ["Q2: harden actuators"]
    ]), "/x/roadmap.pptx");
    // slides were stored reversed; the reader must re-order slide1→slide2→slide3
    expect(text.indexOf("Roadmap 2027")).toBeLessThan(text.indexOf("Q1: ship the daemon"));
    expect(text.indexOf("Q1: ship the daemon")).toBeLessThan(text.indexOf("Q2: harden actuators"));
    expect(text).toContain("Theme: reliability");
  });

  it("orders slide10 AFTER slide2 (numeric, not lexical)", () => {
    const many = Array.from({ length: 10 }, (_, i) => [`point ${(i + 1).toString()}`]);
    const text = pptxToText(makePptx(many));
    expect(text.indexOf("point 2")).toBeLessThan(text.indexOf("point 10"));
  });

  it("routes a .pptx through extractDocumentText as one page — despite being a binary ZIP", async () => {
    const buf = makePptx([["The keynote is on September 3."]]);
    expect(isLikelyBinary(buf)).toBe(true);
    const parsed = await extractDocumentText("/x/keynote.pptx", buf);
    expect(parsed.pageCount).toBe(1);
    expect(parsed.text).toContain("September 3");
  });

  it("throws on a ZIP with no slides (not a real .pptx)", () => {
    const notPptx = makeZip([{ name: "ppt/presentation.xml", data: Buffer.from("<x/>", "utf8") }]);
    expect(() => pptxToText(notPptx, "/x/fake.pptx")).toThrow(/readable \.pptx/u);
  });

  it("the folder walk collects .pptx", async () => {
    expect(SUPPORTED_DOC_EXT.has(".pptx")).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "muse-pptx-"));
    try {
      await writeFile(join(dir, "deck.pptx"), makePptx([["Budget owner is Dana Wu."]]));
      const { documents } = await extractDirectoryDocuments(dir);
      expect(documents.find((d) => d.path.endsWith("deck.pptx"))?.text).toContain("Dana Wu");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
})
