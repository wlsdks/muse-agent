/**
 * Document-format helpers for `file_read` — kind classification (by
 * extension AND by content sniff), image MIME detection, fuzzy filename
 * ranking, the bounded everyday-folder walk, and the lazy PDF/DOCX text
 * extractors. Migrated from `@muse/mcp` so `@muse/fs` owns the whole
 * Claude-Code-grade read surface (path + line ranges + rich documents) in
 * one place; `@muse/mcp`'s web_read imports the PDF extractor back from here.
 *
 * PDF text comes from a lazily-imported pdfjs-dist (Apache-2.0, Mozilla)
 * with script eval disabled; DOCX from a lazily-imported mammoth.
 */

import { readdir as nodeReaddir, stat as nodeStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FileCandidate {
  readonly path: string;
  readonly name: string;
  readonly modifiedMs: number;
}

export type FileKind = "pdf" | "docx" | "image" | "text" | "unsupported";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log", "yaml", "yml", "toml", "ini",
  "ts", "tsx", "js", "mjs", "cjs", "py", "rb", "go", "rs", "java", "swift", "sh", "html", "css", "xml"
]);

const IMAGE_EXTENSIONS = new Map<string, string>([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["gif", "image/gif"], ["webp", "image/webp"], ["bmp", "image/bmp"]
]);

export function classifyFileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? (lower.split(".").pop() ?? "") : "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

/** MIME type for an image file, from its extension then magic bytes. Default image/png. */
export function imageMimeType(name: string, data: Buffer): string {
  const ext = name.toLowerCase().includes(".") ? (name.toLowerCase().split(".").pop() ?? "") : "";
  const byExt = IMAGE_EXTENSIONS.get(ext);
  if (byExt) return byExt;
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
  if (data.length >= 12 && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "image/png";
}

/**
 * Classify by CONTENT, not name — so a misnamed `.txt` that is really a PDF, or
 * an extensionless download, still routes correctly. `%PDF` magic → pdf; a head
 * sample that is NUL-free and overwhelmingly printable (ASCII or UTF-8) → text;
 * anything else → unsupported (binary).
 */
export function sniffFileKind(data: Buffer): FileKind {
  if (data.length === 0) return "unsupported";
  if (data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return "pdf";
  }
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image";
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image";
  const sample = data.subarray(0, 4096);
  if (sample.includes(0x00)) return "unsupported";
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e) || byte >= 0x80) {
      printable += 1;
    }
  }
  return printable / sample.length >= 0.85 ? "text" : "unsupported";
}

/**
 * The kind actually used to read a file: PDF/image magic always wins (catch a
 * mislabeled .txt), then a trusted text/pdf extension, then — for an unknown or
 * missing extension — whatever the bytes say.
 */
export function resolveFileKind(name: string, data: Buffer): FileKind {
  const bySniff = sniffFileKind(data);
  if (bySniff === "pdf" || bySniff === "image") return bySniff;
  const byName = classifyFileKind(name);
  if (byName !== "unsupported") return byName;
  return bySniff;
}

/**
 * Score a candidate against the model's free-text file reference:
 * exact filename > prefix > containment > word overlap; ties resolved by
 * recency (newest first). Zero-score candidates are dropped entirely.
 */
export function rankFileCandidates(candidates: readonly FileCandidate[], query: string): readonly FileCandidate[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const needleWords = needle.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const scoreName = (name: string): number => {
    if (name === needle) return 100;
    if (name.startsWith(needle)) return 80;
    if (name.includes(needle)) return 60;
    const hits = needleWords.filter((word) => name.includes(word)).length;
    return hits === needleWords.length && hits > 0 ? 40 : hits > 0 ? 10 + hits : 0;
  };
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreName(candidate.name.toLowerCase()) }))
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score || b.candidate.modifiedMs - a.candidate.modifiedMs);
  return scored.map((entry) => entry.candidate);
}

const WALK_DEPTH = 3;

export async function walkCandidates(roots: readonly string[]): Promise<readonly FileCandidate[]> {
  const out: FileCandidate[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WALK_DEPTH) return;
    let entries;
    try {
      entries = await nodeReaddir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const { mtimeMs } = await nodeStat(full);
          out.push({ modifiedMs: mtimeMs, name: entry.name, path: full });
        } catch { /* unreadable entry — skip */ }
      }
    }
  };
  for (const root of roots) {
    await walk(root, 0);
  }
  return out;
}

export async function extractPdfTextWithPdfjs(data: Buffer, maxPages = 50): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const doc = await loadingTask.promise;
    const pages = Math.min(doc.numPages, maxPages);
    const parts: string[] = [];
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return parts.join("\n").replace(/[ \t]+/g, " ").trim();
  } finally {
    await loadingTask.destroy();
  }
}

export async function extractDocxTextWithMammoth(data: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: data });
  return result.value.replace(/[ \t]+/g, " ").trim();
}

/**
 * The folders the NAME-fragment read mode searches by default — the user's
 * everyday document folders. Exported so a sibling capability that must read
 * from the SAME allowlist (e.g. `browser_upload`'s path validator) can be wired
 * to the identical roots instead of re-deriving them.
 */
export function defaultFileReadRoots(home: string = homedir()): readonly string[] {
  return [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")];
}
