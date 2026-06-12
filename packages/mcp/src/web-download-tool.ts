/**
 * `web_download` — save a file from a public URL to the user's Downloads.
 *
 * The companion to file_read (read a LOCAL file) and muse.web.read (read a
 * page's TEXT): this fetches a binary/document at a URL the user names and
 * writes it to disk, so "다운로드 받아줘 / save this PDF" works and then
 * file_read can summarize it. Fail-closed: SSRF-guarded to public hosts (a
 * loopback/internal URL is refused), size-capped (no disk fill), and the
 * filename is reduced to a basename (no path-escape write).
 */

import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve as pathResolve } from "node:path";

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { assertPublicHttpUrl, assertPublicHttpUrlSync, type HostLookup } from "./web-url-guard.js";

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

/**
 * The on-disk filename: a model-named `filename` (basename only) wins, else the
 * URL's last path segment, else a timestamp-free default. Always a bare
 * basename — no directory, no `..` — so the write can't escape the download dir.
 */
export function safeDownloadName(filename: string | undefined, url: string): string {
  const fromArg = filename ? basename(filename.trim()) : "";
  if (fromArg && fromArg !== "." && fromArg !== "..") return fromArg;
  let fromUrl = "";
  try {
    fromUrl = basename(new URL(url).pathname);
  } catch { /* unparseable — fall through */ }
  if (fromUrl && fromUrl !== "." && fromUrl !== "..") return fromUrl;
  return "download.bin";
}

export function createWebDownloadTool(deps: WebDownloadToolDeps): MuseTool {
  const downloadDir = deps.downloadDir ?? join(homedir(), "Downloads");
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    definition: {
      description:
        "Download a FILE from a public web URL and save it to the user's Downloads folder. Use when the " +
        "user wants to SAVE / download a file from the web — a PDF, image, spreadsheet, zip, etc. — e.g. " +
        "'download this PDF', 'save that image to my downloads', '이 파일 다운받아줘'. Pass the file's `url`; " +
        "optionally pass `filename` to name it. NOT for reading a web page's text (use web_read) and NOT for " +
        "the user's own local files (use file_read). Only http(s) public URLs.",
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
      const vetted = deps.lookup ? await assertPublicHttpUrl(url, { lookup: deps.lookup }) : assertPublicHttpUrlSync(url);
      if (!vetted.ok) {
        return { reason: vetted.error, saved: false };
      }
      let bytes: Buffer;
      try {
        const response = await deps.fetchImpl(vetted.url.href, { redirect: "follow" });
        if (!response.ok) {
          return { reason: `download failed: HTTP ${response.status.toString()}`, saved: false };
        }
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          return { reason: `file is too large (${Math.round(buf.byteLength / 1024 / 1024).toString()}MB > ${Math.round(maxBytes / 1024 / 1024).toString()}MB cap)`, saved: false };
        }
        bytes = buf;
      } catch (cause) {
        return { reason: `download failed: ${cause instanceof Error ? cause.message : String(cause)}`, saved: false };
      }
      const name = safeDownloadName(typeof args["filename"] === "string" ? args["filename"] : undefined, vetted.url.href);
      const path = pathResolve(downloadDir, name);
      try {
        await writeFile(path, bytes);
      } catch (cause) {
        return { reason: `could not write to Downloads: ${cause instanceof Error ? cause.message : String(cause)}`, saved: false };
      }
      return { bytes: bytes.byteLength, name, path, saved: true };
    }
  };
}
