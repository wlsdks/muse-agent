import { describe, expect, it } from "vitest";

import { filterNotesByScope, looksLikeBinaryContent, selectFilePassages, urlGroundingSource } from "./commands-ask.js";
import { docxToText } from "./document-reader.js";

describe("filterNotesByScope — ground muse ask on one note folder (--scope)", () => {
  const files = [
    { path: "/notes/work/q3.md" },
    { path: "/notes/work/sub/deep.md" }, // a sub-folder under work still counts as work
    { path: "/notes/personal/diary.md" },
    { path: "/notes/inbox.md" } // root-level — not under any folder
  ];

  it("keeps only the files under the scope folder (prefix, incl. deeper sub-folders)", () => {
    expect(filterNotesByScope(files, "/notes", "work").map((f) => f.path)).toEqual(["/notes/work/q3.md", "/notes/work/sub/deep.md"]);
    expect(filterNotesByScope(files, "/notes", "personal").map((f) => f.path)).toEqual(["/notes/personal/diary.md"]);
  });

  it("is case-insensitive and tolerates leading/trailing slashes", () => {
    expect(filterNotesByScope(files, "/notes", "WORK/").map((f) => f.path)).toEqual(["/notes/work/q3.md", "/notes/work/sub/deep.md"]);
    expect(filterNotesByScope(files, "/notes", "/work").length).toBe(2);
  });

  it("returns [] for an unknown folder and everything for an empty scope", () => {
    expect(filterNotesByScope(files, "/notes", "nonexistent")).toEqual([]);
    expect(filterNotesByScope(files, "/notes", "  ")).toEqual(files); // empty → no filtering
  });
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A minimal STORED (uncompressed) ZIP — enough for a .docx the reader can parse,
 *  without pulling in deflate. Mirrors the structure readZipEntry walks. */
function makeStoredZip(entries: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nb = Buffer.from(e.name, "utf8");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(e.data.length, 18);
    h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(nb.length, 26);
    const lr = Buffer.concat([h, nb, e.data]);
    locals.push(lr);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(e.data.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(nb.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([c, nb]));
    offset += lr.length;
  }
  const lb = Buffer.concat(locals);
  const cb = Buffer.concat(centrals);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0);
  eo.writeUInt16LE(entries.length, 8);
  eo.writeUInt16LE(entries.length, 10);
  eo.writeUInt32LE(cb.length, 12);
  eo.writeUInt32LE(lb.length, 16);
  return Buffer.concat([lb, cb, eo]);
}

describe("urlGroundingSource — the cite label for a --url-grounded answer", () => {
  it("uses the host (www. stripped) so the answer cites [from <host>]", () => {
    expect(urlGroundingSource("https://example.com/page")).toBe("example.com");
    expect(urlGroundingSource("https://www.nytimes.com/2026/article")).toBe("nytimes.com");
    expect(urlGroundingSource("http://blog.example.org/")).toBe("blog.example.org");
  });

  it("falls back to the raw string for an unparseable URL", () => {
    expect(urlGroundingSource("not a url")).toBe("not a url");
  });
});

describe("looksLikeBinaryContent — refuse to ground on a binary --file (no hallucinated content)", () => {
  it("flags a buffer with a NUL byte as binary (the canonical text-vs-binary signal)", () => {
    expect(looksLikeBinaryContent(new Uint8Array([0x48, 0x69, 0x00, 0x21]))).toBe(true);
  });

  it("flags a real-shaped PDF (magic header + binary stream bytes) as binary", () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe]);
    expect(looksLikeBinaryContent(pdf)).toBe(true);
  });

  it("flags a run of invalid UTF-8 (high replacement-char ratio) as binary", () => {
    expect(looksLikeBinaryContent(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xc0, 0xc1, 0xf5, 0xf6, 0xf7, 0xf8]))).toBe(true);
  });

  it("treats plain ASCII text as NOT binary", () => {
    expect(looksLikeBinaryContent(bytes("Job title: Staff Data Scientist at Acme.\n"))).toBe(false);
  });

  it("treats valid UTF-8 (Korean + emoji) as NOT binary", () => {
    expect(looksLikeBinaryContent(bytes("내 차 번호판은 12가 3456 🚗 입니다.\n"))).toBe(false);
  });

  it("treats an empty file as NOT binary (nothing to misread)", () => {
    expect(looksLikeBinaryContent(new Uint8Array([]))).toBe(false);
  });

  // The --file inline dispatch handles .docx BEFORE this binary check; if a future
  // edit reorders those branches, a Word doc would be refused instead of read. This
  // pins the two facts that ordering depends on: a real .docx IS binary-flagged
  // (so order matters) AND docxToText recovers its text.
  it("a .docx is binary-flagged yet its text is recoverable (the order the --file dispatch relies on)", () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Codename Bluefin.</w:t></w:r></w:p></w:body></w:document>`;
    const docx = makeStoredZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
      { name: "word/document.xml", data: Buffer.from(xml, "utf8") }
    ]);
    expect(looksLikeBinaryContent(docx)).toBe(true);          // WOULD be refused…
    expect(docxToText(docx, "/x/plan.docx")).toBe("Codename Bluefin."); // …but the docx branch recovers it first
  });
});

describe("selectFilePassages — ad-hoc --file grounding", () => {
  it("returns every passage of a small file, in original order", () => {
    const picked = selectFilePassages("The VPN MTU is 1380.\n\nThe office is at 5th Ave.", "what is the mtu");
    expect(picked.length).toBeGreaterThanOrEqual(1);
    expect(picked.map((p) => p.chunkIndex)).toEqual([...picked.map((p) => p.chunkIndex)].sort((a, b) => a - b));
    expect(picked.some((p) => p.text.includes("1380"))).toBe(true);
  });

  it("ranks the query-relevant passage in, and respects the char budget for a big file", () => {
    const big = Array.from({ length: 50 }, (_u, i) => `Section ${i.toString()}: filler about topic ${i.toString()}.`).join("\n\n")
      + "\n\nThe secret port number is 8443.";
    const picked = selectFilePassages(big, "what is the secret port number", 400);
    const total = picked.reduce((n, p) => n + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(400 + 1200); // budget + at most one overflowing passage
    expect(picked.some((p) => p.text.includes("8443"))).toBe(true); // the relevant passage made the cut
  });

  it("an empty file yields no passages", () => {
    expect(selectFilePassages("", "anything")).toEqual([]);
    expect(selectFilePassages("   \n  ", "anything")).toEqual([]);
  });
});
