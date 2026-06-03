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

import { decodeHeaderValue, extractBody, parseHeaders } from "./mbox-ingest.js";

export interface PdfParsed {
  readonly text: string;
  readonly pageCount: number;
}

/**
 * pdf-parse v2 exposes a `PDFParse` class. Build, extract text, normalise to a
 * tiny `{ text, pageCount }` subset the CLI cares about. Exported for testing.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<PdfParsed> {
  const mod = await import("pdf-parse") as unknown as {
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
  if (isLikelyBinary(buffer)) {
    throw new Error(`'${basename(filePath)}' looks binary — muse read handles PDFs and text files (.txt/.md/.log/.csv).`);
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

/** Extensions `extractDocumentText` can turn into note text. */
export const SUPPORTED_DOC_EXT = new Set([".pdf", ".txt", ".md", ".markdown", ".log", ".csv", ".html", ".htm", ".eml"]);

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

/**
 * Read + extract text from up to `maxFiles` supported documents under `dir` — so
 * `muse ask --file <dir>` can ground on a folder without ingesting it. Each file
 * goes through `extractDocumentText` (PDF or text); a file that fails to read or
 * parse, or that has no text, is skipped (best-effort) rather than aborting the
 * whole directory. Returns `{ path, text }` for every readable doc.
 */
export async function extractDirectoryDocuments(
  dir: string,
  maxFiles = 25
): Promise<{ readonly path: string; readonly text: string }[]> {
  const files = (await walkDocuments(dir)).slice(0, Math.max(1, maxFiles));
  const out: { path: string; text: string }[] = [];
  for (const path of files) {
    try {
      const buffer = await readFile(path);
      const { text } = await extractDocumentText(path, buffer);
      if (text.trim().length > 0) {
        out.push({ path, text });
      }
    } catch {
      // unreadable / binary / malformed — skip this file, keep the rest
    }
  }
  return out;
}
