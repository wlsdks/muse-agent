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
  if (isLikelyBinary(buffer)) {
    throw new Error(`'${basename(filePath)}' looks binary — muse read handles PDFs and text files (.txt/.md/.log/.csv).`);
  }
  return { pageCount: 1, text: buffer.toString("utf8") };
}

/** Extensions `extractDocumentText` can turn into note text. */
export const SUPPORTED_DOC_EXT = new Set([".pdf", ".txt", ".md", ".markdown", ".log", ".csv"]);

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
