/**
 * `web_download` — quarantine a file fetched from a public URL.
 *
 * The companion to file_read (read a LOCAL file) and muse.web.read (read a
 * page's TEXT): this fetches a binary/document at a URL the user names and
 * writes it to disk, so "다운로드 받아줘 / save this PDF" works without
 * immediately exposing untrusted bytes as an ordinary Downloads file.
 * Fail-closed: SSRF-guarded, size-capped, signature-checked, and held in a
 * private quarantine with a content-bound receipt. Nothing is auto-opened.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve as pathResolve } from "node:path";

import type { JsonObject } from "@muse/shared";
import { errorMessage } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { fetchPublicHttpWithRedirects } from "./public-http-redirect.js";
import type { HostLookup } from "./web-url-guard.js";

export interface WebDownloadToolDeps {
  readonly fetchImpl: typeof fetch;
  /** Destination folder. Default ~/Downloads. */
  readonly downloadDir?: string;
  /** DNS resolver for the SSRF guard; defaults to the system lookup. */
  readonly lookup?: HostLookup;
  /** Max bytes to write. Default 50MB. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const QUARANTINE_DIR_NAME = ".muse-quarantine";
const RECEIPT_VERSION = "muse.web-download-receipt/v1";

interface DownloadSignature {
  readonly executable: boolean;
  readonly mediaType: string;
  readonly name: string;
}

function startsWithBytes(bytes: Buffer, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function detectDownloadSignature(bytes: Buffer): DownloadSignature {
  if (startsWithBytes(bytes, [0x7f, 0x45, 0x4c, 0x46])) {
    return { executable: true, mediaType: "application/x-executable", name: "elf" };
  }
  const magic = bytes.subarray(0, 4).toString("hex");
  if (["cafebabe", "bebafeca", "cefaedfe", "cffaedfe", "feedface", "feedfacf"].includes(magic)) {
    return { executable: true, mediaType: "application/x-mach-binary", name: "mach-o" };
  }
  if (startsWithBytes(bytes, [0x4d, 0x5a])) {
    return { executable: true, mediaType: "application/vnd.microsoft.portable-executable", name: "pe" };
  }
  if (startsWithBytes(bytes, [0x23, 0x21])) {
    return { executable: true, mediaType: "text/x-shellscript", name: "shebang-script" };
  }
  if (startsWithBytes(bytes, [0x00, 0x61, 0x73, 0x6d])) {
    return { executable: true, mediaType: "application/wasm", name: "wasm" };
  }
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { executable: false, mediaType: "application/pdf", name: "pdf" };
  }
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { executable: false, mediaType: "image/png", name: "png" };
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return { executable: false, mediaType: "image/jpeg", name: "jpeg" };
  }
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") {
    return { executable: false, mediaType: "image/gif", name: "gif" };
  }
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return { executable: false, mediaType: "application/zip", name: "zip" };
  }
  return { executable: false, mediaType: "application/octet-stream", name: "unknown" };
}

function normalizedMediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

const EXECUTABLE_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "application/wasm",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-mach-binary",
  "application/x-msdownload",
  "application/x-sh",
  "text/x-shellscript"
]);

const EXECUTABLE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  elf: ["", ".bin", ".run"],
  "mach-o": ["", ".bin"],
  pe: [".dll", ".exe"],
  "shebang-script": [".bash", ".command", ".sh", ".zsh"],
  wasm: [".wasm"]
};
const EXECUTABLE_FILENAME_EXTENSIONS = new Set(
  Object.values(EXECUTABLE_EXTENSIONS).flat().filter(
    (value) => value.length > 0 && value !== ".bin"
  )
);
const SIGNATURE_FILENAME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  gif: [".gif"],
  jpeg: [".jpeg", ".jpg"],
  pdf: [".pdf"],
  png: [".png"],
  zip: [".docx", ".jar", ".pptx", ".xlsx", ".zip"]
};

function signatureMismatchReason(
  declaredType: string,
  signature: DownloadSignature,
  name: string
): string | undefined {
  const extension = extname(name).toLowerCase();
  if (signature.executable) {
    const allowedExtensions = EXECUTABLE_EXTENSIONS[signature.name] ?? [];
    if (!EXECUTABLE_MEDIA_TYPES.has(declaredType) || !allowedExtensions.includes(extension)) {
      return `download blocked: executable ${signature.name} bytes do not match declared type '${declaredType}' and filename '${name}'`;
    }
    return undefined;
  }
  if (EXECUTABLE_MEDIA_TYPES.has(declaredType) && declaredType !== "application/octet-stream") {
    return `download blocked: server declared executable type '${declaredType}' but content signature is '${signature.name}'`;
  }
  if (EXECUTABLE_FILENAME_EXTENSIONS.has(extension)) {
    return `download blocked: executable filename '${name}' does not match detected ${signature.name} content`;
  }
  const expectedExtensions = SIGNATURE_FILENAME_EXTENSIONS[signature.name];
  if (expectedExtensions && !expectedExtensions.includes(extension)) {
    return `download blocked: filename '${name}' does not match detected ${signature.name} content`;
  }
  if (
    signature.mediaType !== "application/octet-stream"
    && declaredType !== "application/octet-stream"
    && declaredType !== signature.mediaType
  ) {
    return `download blocked: detected ${signature.mediaType} bytes but server declared '${declaredType}'`;
  }
  return undefined;
}

/**
 * The on-disk filename: a model-named `filename` (basename only) wins, else the
 * URL's last path segment, else a timestamp-free default. Always a bare
 * basename — no directory, no `..` — so the write can't escape the download dir.
 */
export function safeDownloadName(filename: string | undefined, url: string): string {
  const clean = (value: string): string => {
    const portableBase = basename(value.trim()).split(/[\\/]/u).at(-1) ?? "";
    return portableBase.replace(/[\u0000-\u001f\u007f]/gu, "_").trim();
  };
  const fromArg = filename ? clean(filename) : "";
  if (fromArg && fromArg !== "." && fromArg !== "..") return fromArg;
  let fromUrl = "";
  try {
    fromUrl = clean(decodeURIComponent(new URL(url).pathname));
  } catch { /* unparseable — fall through */ }
  if (fromUrl && fromUrl !== "." && fromUrl !== "..") return fromUrl;
  return "download.bin";
}

/**
 * Write `bytes` under a NON-clobbering name in `dir`: if `<dir>/<name>` already
 * exists, dedupe like a browser — `name (1).ext`, `name (2).ext`, … — so a download
 * NEVER silently destroys an unrelated file the user already had. The `wx` flag
 * (fail if exists) makes the exists-check + create atomic (no TOCTOU race). Returns
 * the actual name/path used.
 */
export async function writeNonClobbering(dir: string, name: string, bytes: Buffer): Promise<{ name: string; path: string }> {
  const resolvedDir = pathResolve(dir);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? name : `${stem} (${i.toString()})${ext}`;
    const path = pathResolve(resolvedDir, candidate);
    if (dirname(path) !== resolvedDir) {
      throw new Error(`refused download path outside quarantine: ${candidate}`);
    }
    const parentBefore = await lstat(resolvedDir);
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
      throw new Error("quarantine parent is not a real directory");
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_WRONLY,
        0o600
      );
      const [parentAfter, openedFile] = await Promise.all([
        lstat(resolvedDir),
        handle.stat()
      ]);
      if (
        !parentAfter.isDirectory()
        || parentAfter.isSymbolicLink()
        || parentAfter.dev !== parentBefore.dev
        || parentAfter.ino !== parentBefore.ino
        || !openedFile.isFile()
        || openedFile.nlink !== 1
      ) {
        throw new Error("quarantine parent changed while creating the download");
      }
      await handle.writeFile(bytes);
      await handle.sync();
      return { name: candidate, path };
    } catch (cause) {
      if ((cause as { code?: string }).code === "EEXIST") continue; // taken — try the next dedupe suffix
      if (handle) {
        const openedFile = await handle.stat().catch(() => undefined);
        const currentPath = await lstat(path).catch(() => undefined);
        if (
          openedFile
          && currentPath
          && openedFile.dev === currentPath.dev
          && openedFile.ino === currentPath.ino
        ) {
          await unlink(path).catch(() => undefined);
        }
      }
      throw cause;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  throw new Error(`too many filename collisions for "${name}" in the downloads dir`);
}

export function createWebDownloadTool(deps: WebDownloadToolDeps): MuseTool {
  const downloadDir = deps.downloadDir ?? join(homedir(), "Downloads");
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    definition: {
      description:
        "Download a FILE from a public web URL into a private quarantine under the user's Downloads folder. Use when the " +
        "user wants to SAVE / download a file from the web — a PDF, image, spreadsheet, zip, etc. — e.g. " +
        "'download this PDF', 'save that image to my downloads', '이 파일 다운받아줘'. Pass the file's `url`; " +
        "optionally pass `filename` to name it. NOT for reading a web page's text (use web_read) and NOT for " +
        "the user's own local files (use file_read). Only http(s) public URLs. A quarantine receipt is returned; " +
        "Muse never opens or executes the file automatically.",
      domain: "web",
      groundedArgs: ["url", "filename"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          filename: { description: "Optional name to save as, e.g. 'invoice.pdf'. Defaults to the URL's filename.", type: "string" },
          url: { description: "The file's URL, e.g. 'https://example.com/report.pdf'.", type: "string" }
        },
        required: ["url"],
        type: "object"
      },
      keywords: ["download", "다운로드", "다운받", "save file", "저장", "받아줘", "fetch file", "pdf", "image"],
      name: "web_download",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      if (url.length === 0) {
        return { reason: "web_download requires a 'url'", saved: false };
      }
      let bytes: Buffer;
      let declaredType: string;
      let finalUrl: string;
      try {
        const fetched = await fetchPublicHttpWithRedirects(url, {
          fetchImpl: deps.fetchImpl,
          ...(deps.lookup ? { lookup: deps.lookup } : {}),
          // A download remains a single physical call on a network rejection:
          // do not inherit the generic read retry/timeout defaults here.
          retryOptions: { retries: 0, retryOnNetworkError: false, timeoutMs: 0 }
        });
        if (!fetched.ok) {
          return { reason: fetched.message, saved: false };
        }
        const response = fetched.response;
        finalUrl = fetched.finalUrl;
        declaredType = normalizedMediaType(response.headers.get("content-type"));
        if (!response.ok) {
          return { reason: `download failed: HTTP ${response.status.toString()}`, saved: false };
        }
        const tooLarge = (size: number): JsonObject =>
          ({ reason: `file is too large (${Math.round(size / 1024 / 1024).toString()}MB > ${Math.round(maxBytes / 1024 / 1024).toString()}MB cap)`, saved: false });
        // Don't buffer the WHOLE body before the cap check — a multi-GB / never-ending
        // response would fill RAM despite the cap. Reject early on a Content-Length that
        // already exceeds it, then read chunk-by-chunk and abort the moment the
        // accumulated size crosses the cap (the server can lie about Content-Length).
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          return tooLarge(declared);
        }
        const reader = response.body?.getReader();
        if (!reader) {
          const buf = Buffer.from(await response.arrayBuffer());
          if (buf.byteLength > maxBytes) return tooLarge(buf.byteLength);
          bytes = buf;
        } else {
          const chunks: Buffer[] = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
              await reader.cancel().catch(() => undefined);
              return tooLarge(total);
            }
            chunks.push(Buffer.from(value));
          }
          bytes = Buffer.concat(chunks);
        }
      } catch (cause) {
        return { reason: `download failed: ${errorMessage(cause)}`, saved: false };
      }
      const name = safeDownloadName(typeof args["filename"] === "string" ? args["filename"] : undefined, finalUrl);
      const signature = detectDownloadSignature(bytes);
      const mismatch = signatureMismatchReason(declaredType, signature, name);
      if (mismatch) {
        return { reason: mismatch, saved: false };
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const quarantineDir = join(pathResolve(downloadDir), QUARANTINE_DIR_NAME);
      let saved: { name: string; path: string };
      try {
        await mkdir(quarantineDir, { mode: 0o700, recursive: true });
        const [downloadRoot, quarantineRoot, quarantineStat] = await Promise.all([
          realpath(downloadDir),
          realpath(quarantineDir),
          lstat(quarantineDir)
        ]);
        if (
          quarantineStat.isSymbolicLink()
          || quarantineRoot !== join(downloadRoot, QUARANTINE_DIR_NAME)
        ) {
          throw new Error("quarantine directory escapes the configured Downloads folder");
        }
        saved = await writeNonClobbering(quarantineRoot, name, bytes);
      } catch (cause) {
        return { reason: `could not write to download quarantine: ${errorMessage(cause)}`, saved: false };
      }
      return {
        bytes: bytes.byteLength,
        name: saved.name,
        path: saved.path,
        receipt: {
          autoOpened: false,
          bytes: bytes.byteLength,
          declaredType,
          signature: signature.name,
          detectedType: signature.mediaType,
          finalUrl,
          name: saved.name,
          quarantineState: "held",
          schemaVersion: RECEIPT_VERSION,
          sha256,
          sourceUrl: url
        },
        saved: true
      };
    }
  };
}
