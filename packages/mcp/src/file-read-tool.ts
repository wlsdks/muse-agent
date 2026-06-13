/**
 * `file_read` — read a document from the user's everyday folders by NAME.
 *
 * Same grounding philosophy as the browser matcher: the small model names
 * what it wants ("invoice pdf", "report.md") and deterministic code resolves
 * it — newest match wins, an unmatched name returns the recent files instead
 * of a guess, a path outside the allowed roots is refused (fail-closed,
 * the muse.fs allowlist posture). PDF text comes from a lazily-imported
 * pdfjs-dist (Apache-2.0, Mozilla) with script eval disabled.
 */

import { readdir as nodeReaddir, readFile as nodeReadFile, realpath as nodeRealpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve, sep as pathSep } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

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
  // A name with no dot has no extension — `split(".").pop()` would return the
  // whole name, so guard that explicitly (an extensionless file is "unknown").
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
  // Image magic bytes: PNG \x89PNG, JPEG \xFF\xD8\xFF, GIF GIF8, WEBP RIFF…WEBP.
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
 * The kind actually used to read a file: PDF magic always wins (catch a
 * mislabeled .txt), then a trusted text/pdf extension, then — for an unknown or
 * missing extension — whatever the bytes say. Extension is the fast path; the
 * sniff is the correction.
 */
export function resolveFileKind(name: string, data: Buffer): FileKind {
  const bySniff = sniffFileKind(data);
  // Magic-detected binary formats win over a misleading extension (a .txt that
  // is really a PDF or an image must not be read as utf8).
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

export interface FileReadFsImpl {
  /** All readable files under the roots (depth-bounded walk). */
  listCandidates(roots: readonly string[]): Promise<readonly FileCandidate[]>;
  readFile(path: string): Promise<Buffer>;
  /**
   * Resolve symlinks to the real on-disk path. Optional: when absent (a test
   * fake with no symlinks), the path is treated as its own realpath. The
   * default fs provides the real resolver so a symlink under the roots that
   * points OUTSIDE them is caught before the read.
   */
  realpath?(path: string): Promise<string>;
}

export interface FileReadToolDeps {
  /** Folders the tool may read. Default: ~/Downloads, ~/Desktop, ~/Documents. */
  readonly roots?: readonly string[];
  readonly fsImpl?: FileReadFsImpl;
  /** PDF text extractor; defaults to the lazy pdfjs-dist implementation. */
  readonly extractPdfText?: (data: Buffer) => Promise<string>;
  /** DOCX (Word) text extractor; defaults to the lazy mammoth implementation. */
  readonly extractDocxText?: (data: Buffer) => Promise<string>;
  /**
   * Local vision callback for IMAGE files (bound by the CLI to the assembly's
   * multimodal model — @muse/mcp stays model-free). Absent ⇒ image files are
   * refused ("unsupported") as before.
   */
  readonly describeImage?: (input: { readonly imageBase64: string; readonly mimeType: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
  /** Cap on returned characters. Default 20,000. */
  readonly maxTextChars?: number;
  /** Files larger than this are refused. Default 25MB. */
  readonly maxFileBytes?: number;
}

const WALK_DEPTH = 3;
const RECENT_LIST = 10;

async function walkCandidates(roots: readonly string[]): Promise<readonly FileCandidate[]> {
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
          const { mtimeMs } = await import("node:fs/promises").then((fs) => fs.stat(full));
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
 * The folders `file_read` reads by default — the user's everyday document
 * folders. Exported so a sibling capability that must read from the SAME
 * allowlist (e.g. `browser_upload`'s path validator) can be wired to the
 * identical roots instead of re-deriving them.
 */
export function defaultFileReadRoots(home: string = homedir()): readonly string[] {
  return [join(home, "Downloads"), join(home, "Desktop"), join(home, "Documents")];
}

export function createFileReadTool(deps: FileReadToolDeps = {}): MuseTool {
  const roots = (deps.roots ?? defaultFileReadRoots())
    .map((root) => pathResolve(root));
  const fsImpl: FileReadFsImpl = deps.fsImpl ?? { listCandidates: walkCandidates, readFile: (path) => nodeReadFile(path), realpath: (path) => nodeRealpath(path) };
  // When the fs provides no realpath (a test fake with no symlinks), treat each
  // path as its own realpath — the symlink-escape guard is a no-op there.
  const realpathOf = fsImpl.realpath ? (path: string) => fsImpl.realpath!(path) : async (path: string) => path;
  const extractPdf = deps.extractPdfText ?? extractPdfTextWithPdfjs;
  const extractDocx = deps.extractDocxText ?? extractDocxTextWithMammoth;
  const maxTextChars = deps.maxTextChars ?? 20_000;
  const maxFileBytes = deps.maxFileBytes ?? 25 * 1024 * 1024;
  return {
    definition: {
      description:
        "Read a document FILE from the user's Downloads, Desktop, or Documents folder and return its text " +
        "— PDF, Word (.docx), and images (read with the local vision model) included. Say WHICH file in `file` — a filename " +
        "or part of one ('invoice pdf', 'report.md', '계약서 워드', '영수증 사진') — and Muse finds the newest match. Use " +
        "when the user asks to read / open / summarize a file on their computer — e.g. '다운로드에 있는 " +
        "invoice.pdf 요약해줘', 'read the Word doc on my Desktop'. NOT for the user's Muse notes " +
        "(muse.notes.search) and NOT for just locating a file's path (mac_spotlight_search).",
      domain: "files",
      groundedArgs: ["file"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          file: {
            description: "The file to read — a filename or fragment, e.g. 'invoice.pdf' or '5월 영수증', or an absolute path.",
            type: "string"
          }
        },
        required: ["file"],
        type: "object"
      },
      keywords: ["file", "파일", "pdf", "문서", "document", "읽어", "downloads", "다운로드", "desktop", "바탕화면", "documents", "summarize", "요약"],
      name: "file_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const query = typeof args["file"] === "string" ? args["file"].trim() : "";
      if (query.length === 0) {
        return { read: false, reason: "file_read needs `file` — the filename (or part of it) to read" };
      }
      try {
        let target: FileCandidate | undefined;
        if (query.startsWith("/") || query.startsWith("~")) {
          const resolved = pathResolve(query.replace(/^~(?=\/|$)/, homedir()));
          if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${pathSep}`))) {
            return { read: false, reason: `'${query}' is outside the readable folders (${roots.join(", ")})` };
          }
          target = { modifiedMs: 0, name: resolved.split(pathSep).pop() ?? resolved, path: resolved };
        } else {
          const candidates = await fsImpl.listCandidates(roots);
          const ranked = rankFileCandidates(candidates, query);
          target = ranked[0];
          if (!target) {
            const recent = [...candidates].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, RECENT_LIST).map((c) => c.name);
            return { read: false, reason: `no file matching "${query}" — recent files listed`, recent: recent as unknown as JsonValue };
          }
        }
        // Symlink-escape guard: a file lexically inside the roots may be a
        // symlink pointing OUTSIDE them (e.g. ~/Downloads/x → /etc/passwd). The
        // lexical roots check above only sees the link's own path, so re-check
        // the REAL path (and realpath the roots too — /tmp is itself a symlink
        // on macOS) before reading. A realpath error (missing file) refuses.
        let realTarget: string;
        try {
          realTarget = await realpathOf(target.path);
        } catch {
          return { read: false, reason: `'${target.name}' could not be resolved on disk` };
        }
        const realRoots = await Promise.all(roots.map((root) => realpathOf(root).catch(() => root)));
        if (!realRoots.some((root) => realTarget === root || realTarget.startsWith(`${root}${pathSep}`))) {
          return { read: false, reason: `'${target.name}' resolves through a link to outside the readable folders` };
        }
        const data = await fsImpl.readFile(target.path);
        if (data.byteLength > maxFileBytes) {
          return { read: false, reason: `'${target.name}' is too large (${Math.round(data.byteLength / 1024 / 1024).toString()}MB > 25MB)` };
        }
        // Classify by CONTENT (with the extension as a hint): an extensionless
        // download or a misnamed file still reads, a binary blob is still refused.
        const kind = resolveFileKind(target.name, data);
        if (kind === "image") {
          if (!deps.describeImage) {
            return { read: false, reason: `'${target.name}' is an image — image reading needs the local vision model, not available in this run` };
          }
          const described = await deps.describeImage({ imageBase64: data.toString("base64"), mimeType: imageMimeType(target.name, data) });
          if (!described.ok || !described.text) {
            return { read: false, reason: described.error ?? "the vision model could not read the image" };
          }
          return { kind: "image", name: target.name, path: target.path, read: true, text: described.text, truncated: false };
        }
        if (kind === "unsupported") {
          return { read: false, reason: `'${target.name}' is not a readable document (PDF, Word, text, or image files only)` };
        }
        const text = kind === "pdf" ? await extractPdf(data) : kind === "docx" ? await extractDocx(data) : data.toString("utf8");
        const truncated = text.length > maxTextChars;
        return {
          name: target.name,
          path: target.path,
          read: true,
          text: truncated ? text.slice(0, maxTextChars) : text,
          truncated
        };
      } catch (cause) {
        return { read: false, reason: cause instanceof Error ? cause.message : String(cause) };
      }
    }
  };
}
