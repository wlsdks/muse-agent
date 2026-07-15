/**
 * Local document text extraction — shared by `muse read` (ingest to notes) and
 * `muse ask --file` (ad-hoc grounding). A leaf module with no command imports so
 * either side can use it without an import cycle. PDFs go through `pdf-parse`
 * (MIT, pure JS, dynamically imported so it loads only when a PDF is read);
 * everything else is read as UTF-8 text, and a binary non-PDF is refused so its
 * garbled bytes never reach the model.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { decodeHeaderValue, extractBody, parseHeaders } from "./mime.js";

export interface PdfParsed {
  readonly text: string;
  readonly pageCount: number;
}

/**
 * pdf-parse v2 exposes a `PDFParse` class. Build, extract text, normalise to a
 * tiny `{ text, pageCount }` subset the CLI cares about. Exported for testing.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<PdfParsed> {
  const mod = await import("pdf-parse") as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text?: string; total?: number; pages?: unknown[] }>;
    };
  };
  const parser = new mod.PDFParse({ data: buffer });
  const result = await parser.getText();
  const pageCount = typeof result.total === "number"
    ? result.total
    : Array.isArray(result.pages) ? result.pages.length : 0;
  return { text: result.text ?? "", pageCount };
}

/** A file is treated as PDF by its `.pdf` extension OR a `%PDF-` magic header. */
export function isPdfDocument(filePath: string, buffer: Buffer): boolean {
  return filePath.toLowerCase().endsWith(".pdf") || buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** A NUL byte in the first 8KB marks a binary file (jpg/png/zip/…) — not readable text. */
export function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Extract text from a local document: a PDF via pdf-parse, otherwise a UTF-8
 * text file (`.txt` / `.md` / `.log` / `.csv` / transcript — one "page"). Throws
 * on a binary non-PDF so the caller reports clearly instead of dumping garbage.
 * Exported for testing.
 */
export async function extractDocumentText(filePath: string, buffer: Buffer): Promise<PdfParsed> {
  if (isPdfDocument(filePath, buffer)) {
    return parsePdfBuffer(buffer);
  }
  if (isEmlDocument(filePath)) {
    // A saved email (.eml) is raw RFC822/MIME — headers, quoted-printable/base64
    // bodies, multipart boundaries. Grounding on that noise buries the message;
    // extract the subject/sender + decoded readable body instead.
    return { pageCount: 1, text: emlToText(buffer.toString("utf8")) };
  }
  if (isDocxDocument(filePath)) {
    // A Word .docx is a ZIP of XML and so reads as binary — it MUST be handled
    // before the binary refusal below. Extract the document body text.
    return { pageCount: 1, text: docxToText(buffer, filePath) };
  }
  if (isPptxDocument(filePath)) {
    // A PowerPoint .pptx is likewise a ZIP of XML — extract every slide's text.
    return { pageCount: 1, text: pptxToText(buffer, filePath) };
  }
  if (isLikelyBinary(buffer)) {
    throw new Error(`'${basename(filePath)}' looks binary — muse read handles PDFs, Word .docx, PowerPoint .pptx, and text files (.txt/.md/.log/.csv).`);
  }
  if (isHtmlDocument(filePath)) {
    // Grounding on raw HTML feeds the model markup + <script>/<style> noise and
    // leaves entities undecoded (an email "jane&#64;globex.com" stays mangled).
    // Extract the readable text instead.
    return { pageCount: 1, text: htmlToText(buffer.toString("utf8")) };
  }
  return { pageCount: 1, text: buffer.toString("utf8") };
}

/** A file is treated as HTML by its extension — its bytes are still UTF-8 text. */
export function isHtmlDocument(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/** A saved email message, by extension (.eml). */
export function isEmlDocument(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".eml");
}

/** A Word document, by extension (.docx). */
export function isDocxDocument(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".docx");
}

/** A PowerPoint presentation, by extension (.pptx). */
export function isPptxDocument(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pptx");
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compSize: number;
  readonly localOffset: number;
}

/**
 * Parse a ZIP's central directory (the authoritative index at the end of the
 * file, robust to streamed-write data descriptors that leave local-header sizes
 * zero) and return every entry's metadata. The shared backbone for the Office
 * Open XML readers (`.docx` / `.pptx`) — both are ZIPs whose text lives in XML
 * parts. No third-party dep. Returns [] for a non-ZIP / unreadable buffer.
 */
function zipCentralEntries(buffer: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  // Scan backward for the End-Of-Central-Directory record (its variable-length
  // comment means it isn't at a fixed offset). 22 bytes fixed + ≤65535 comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0xffff; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return [];
  }
  const cdCount = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16); // central-directory offset
  const entries: ZipEntry[] = [];
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CDH_SIG) {
      break;
    }
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const fnLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + fnLen);
    entries.push({ name, method, compSize, localOffset });
    p += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

// A single .docx/.pptx part decompresses to at MOST this. Generous for any real
// document part, but a hard ceiling on a DEFLATE bomb: without it, a ~500 KB
// crafted file inflates to gigabytes (measured ~1000:1) and OOMs / hangs the
// process. Over-cap ⇒ the part is skipped, not read (graceful, never a crash).
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;

/** Decompress one central-directory entry. Only the two methods a .docx/.pptx
 *  ever uses are handled: store (0) and raw-DEFLATE (8, via Node's zlib). */
function inflateZipEntry(buffer: Buffer, entry: ZipEntry): Buffer | null {
  // The local header repeats the filename/extra lengths (they may differ from
  // the central record), so read THEM to find the data start.
  const localFnLen = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLen = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + localFnLen + localExtraLen;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) {
    // Store has no amplification, but still refuse a pathologically large part.
    return compressed.byteLength > MAX_ZIP_ENTRY_BYTES ? null : compressed;
  }
  if (entry.method === 8) {
    try {
      // maxOutputLength bounds the decompression: a bomb exceeding it throws a
      // RangeError instead of allocating unbounded memory — caught → skip.
      return inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
    } catch {
      return null;
    }
  }
  return null;
}

/** Locate ONE entry by exact name and return its decompressed bytes, or null. */
function readZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  const entry = zipCentralEntries(buffer).find((e) => e.name === entryName);
  return entry ? inflateZipEntry(buffer, entry) : null;
}

/**
 * Reduce an Office Open XML body (Word `<w:…>` or PowerPoint `<a:…>`) to readable
 * text: paragraphs (`</w:p>` / `</a:p>`), line breaks (`<w:br/>` / `<a:br>`) and
 * tabs (`<w:tab/>`) become whitespace, every other tag is dropped, and XML
 * entities are decoded. The only text between tags in these parts is the run
 * content, so tag-stripping yields exactly the visible text — "good enough" to
 * ground on, not a faithful render.
 */
function ooxmlRunsToText(xml: string): string {
  const withBreaks = xml
    .replace(/<\/(?:w|a):p>/giu, "\n")
    .replace(/<(?:w|a):br\s*\/?>/giu, "\n")
    .replace(/<(?:w|a):tab\s*\/?>/giu, "\t");
  const stripped = withBreaks.replace(/<[^>]+>/gu, "");
  return decodeHtmlEntities(stripped)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Extract the readable body text of a Word `.docx` — the `<w:t>` runs inside
 * `word/document.xml`. Throws when the file isn't a readable .docx so the caller
 * reports clearly. Exported for testing.
 */
export function docxToText(buffer: Buffer, filePath = "document.docx"): string {
  const xml = readZipEntry(buffer, "word/document.xml");
  if (!xml) {
    throw new Error(`'${basename(filePath)}' isn't a readable .docx (no word/document.xml inside).`);
  }
  return ooxmlRunsToText(xml.toString("utf8"));
}

/** The slide number in `ppt/slides/slideN.xml`, for ordering (so slide10 sorts after slide2). */
function slideNumber(entryName: string): number {
  const m = /slide(\d+)\.xml$/u.exec(entryName);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

/**
 * Extract the readable text of a PowerPoint `.pptx` — every slide's `<a:t>` runs,
 * slides concatenated in slide-number order (blank line between slides). Throws
 * when the file has no slides (not a readable .pptx) so the caller reports
 * clearly. Exported for testing.
 */
export function pptxToText(buffer: Buffer, filePath = "presentation.pptx"): string {
  const slideNames = zipCentralEntries(buffer)
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/u.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slideNames.length === 0) {
    throw new Error(`'${basename(filePath)}' isn't a readable .pptx (no slides inside).`);
  }
  const slides = slideNames
    .map((name) => {
      const xml = readZipEntry(buffer, name);
      return xml ? ooxmlRunsToText(xml.toString("utf8")) : "";
    })
    .filter((text) => text.length > 0);
  return slides.join("\n\n");
}

/**
 * Reduce a raw .eml (RFC822/MIME) to readable text to ground on: the decoded
 * Subject / From / Date plus the decoded body (the first text/plain part of a
 * multipart, quoted-printable / base64 unwound, HTML stripped) — reusing the
 * same MIME parser `muse read --mbox` ingest uses, so an email reads as the
 * message, not as raw headers and `=3D`-encoded markup. Exported for testing.
 */
export function emlToText(rawEml: string): string {
  const parsed = parseHeaders(rawEml);
  const header = (name: string): string => decodeHeaderValue(parsed.headers.get(name) ?? "").trim();
  const lines = [
    header("subject") ? `Subject: ${header("subject")}` : "",
    header("from") ? `From: ${header("from")}` : "",
    (parsed.headers.get("date") ?? "").trim() ? `Date: ${(parsed.headers.get("date") ?? "").trim()}` : ""
  ].filter((line) => line.length > 0);
  const body = extractBody(parsed).trim();
  return [lines.join("\n"), body].filter((part) => part.length > 0).join("\n\n").trim();
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…"
};

/** Decode the HTML entities that actually mangle grounded values (numeric + the common named ones). */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/giu, (match, name: string) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/**
 * Reduce an HTML document to its readable text: drop `<script>`/`<style>`
 * blocks and comments, strip the remaining tags, decode entities, and collapse
 * whitespace. Regex-based (no DOM dependency) — "good enough" to ground on, not a
 * faithful render. Exported for testing.
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]+>/gu, " ");
  return decodeHtmlEntities(stripped).replace(/\s+/gu, " ").trim();
}

/**
 * Extensions the folder walk (`muse ask --file <dir>` + `muse read <dir>`)
 * collects. Covers every PROSE format the notes index perceives (commands-notes-rag
 * `NOTE_FILE_RE`: org-mode, reStructuredText, AsciiDoc, MDX, markdown variants) —
 * so a power-user's `.org`/`.rst`/`.adoc` notes aren't silently skipped by ad-hoc
 * folder grounding/ingest while the index includes them — PLUS this reader's own
 * document extras (`.log`/`.csv`/`.html`/`.htm`/`.eml`/`.docx`/`.pptx`, special-cased above). A
 * single non-supported text file still reads (UTF-8 pass-through); only the
 * directory walk is gated, so it must stay aligned with `NOTE_FILE_RE` (guarded by
 * a drift test).
 */
export const SUPPORTED_DOC_EXT = new Set([
  ".pdf",
  ".txt", ".text",
  ".md", ".markdown", ".mkd", ".mdown", ".mdx",
  ".org", ".rst", ".adoc", ".asciidoc",
  ".log", ".csv",
  ".html", ".htm",
  ".eml",
  ".docx", ".pptx"
]);

/** Recursively collect supported document files under `dir` (skips hidden + `.processed`), sorted. */
export async function walkDocuments(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && SUPPORTED_DOC_EXT.has(extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

export interface DirectoryDocumentsResult {
  /** The documents read (capped at `cap`; binary / empty files skipped). */
  readonly documents: readonly { readonly path: string; readonly text: string }[];
  /** Total SUPPORTED documents in the folder BEFORE the cap — so the caller can
   *  warn that some weren't read, instead of silently grounding on a subset. */
  readonly totalFound: number;
  /** The read cap applied (`maxFiles`). */
  readonly cap: number;
}

/**
 * Read + extract text from up to `maxFiles` supported documents under `dir` — so
 * `muse ask --file <dir>` can ground on a folder without ingesting it. Each file
 * goes through `extractDocumentText` (PDF or text); a file that fails to read or
 * parse, or that has no text, is skipped (best-effort) rather than aborting the
 * whole directory. Returns the read documents PLUS `totalFound` / `cap` so the
 * caller can be HONEST when a big folder was truncated (no silent cap).
 */
export async function extractDirectoryDocuments(
  dir: string,
  maxFiles = 25
): Promise<DirectoryDocumentsResult> {
  const cap = Math.max(1, maxFiles);
  const allFiles = await walkDocuments(dir);
  const files = allFiles.slice(0, cap);
  const documents: { path: string; text: string }[] = [];
  for (const path of files) {
    try {
      const buffer = await readFile(path);
      const { text } = await extractDocumentText(path, buffer);
      if (text.trim().length > 0) {
        documents.push({ path, text });
      }
    } catch {
      // unreadable / binary / malformed — skip this file, keep the rest
    }
  }
  return { cap, documents, totalFound: allFiles.length };
}

/**
 * The honest "I didn't read everything" notice for `muse ask --file <dir>`: when a
 * folder has MORE supported documents than the read cap, the answer grounds on only
 * the first `cap`, so SAY SO — a missing answer shouldn't be mistaken for "not in
 * your documents" (Muse shows its work). Empty when nothing was dropped. Pure.
 */
export function formatDirectoryCapNotice(folder: string, totalFound: number, cap: number): string {
  if (totalFound <= cap) {
    return "";
  }
  return `muse: ${folder} has ${totalFound.toString()} documents — grounding on the first ${cap.toString()} only; the other ${(totalFound - cap).toString()} were NOT read. Ask about a narrower subset, or split the folder.\n`;
}

/**
 * The `--url` twin of the folder-cap notice: a long web page is fetched only up
 * to a character cap, so when it was truncated SAY SO — otherwise an answer that
 * lives past the cap reads as "the page doesn't say" when really Muse never read
 * that far (Muse shows its work). Pure.
 */
export function formatUrlTruncationNotice(source: string, maxChars: number): string {
  return `muse: ${source} is long — grounded on only the first ${maxChars.toLocaleString("en-US")} characters; anything past that was NOT read. If your answer might be deeper in the page, ask about a specific section.\n`;
}
