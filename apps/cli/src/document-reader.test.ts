import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOTE_FILE_RE } from "./commands-notes-rag.js";
import { SUPPORTED_DOC_EXT, emlToText, extractDirectoryDocuments, extractDocumentText, formatDirectoryCapNotice, formatUrlTruncationNotice, htmlToText, isEmlDocument, isHtmlDocument, isLikelyBinary, isPdfDocument, parsePdfBuffer, walkDocuments } from "./document-reader.js";

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
    // Non-markdown PROSE notes the index already perceives (P37-25) — must NOT be
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
    const found = (await walkDocuments(dir)).map((p) => p.replace(`${dir}/`, ""));
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
    const byName = Object.fromEntries(docs.map((d) => [d.path.replace(`${dir}/`, ""), d.text]));
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
