/**
 * Fetch a PUBLIC web page and return its readable text — SSRF-guarded
 * (before the fetch AND on the post-redirect final URL), retry-hardened
 * (429/5xx via fetchWithRetry), and stripped to readable text via
 * extractReadableText. The shared core behind the `web_read` perception tool
 * and `muse notes ingest --url`, so both reach the web the same safe way.
 *
 * Read-only. `fetchImpl` / `lookup` / `retryOptions` are injected so the path
 * is exercised over real request shapes with only the network faked.
 */

import { fetchWithRetry, type RetryOptions } from "@muse/mcp-shared";
import { extractReadableText } from "./web-readable.js";
import { assertPublicHttpUrl, type HostLookup } from "./web-url-guard.js";

export interface FetchReadableUrlOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly lookup?: HostLookup;
  readonly retryOptions?: RetryOptions;
  /** Per-attempt fetch timeout. Default 15,000ms. */
  readonly timeoutMs?: number;
  /** Cap on returned readable text. Default extractReadableText's own (16k). */
  readonly maxChars?: number;
  /**
   * Optional PDF text extractor. When the URL serves `application/pdf` AND this
   * is provided, the body is read as bytes and run through it (instead of being
   * refused as non-text), so `muse ask --url <pdf>` can ground on an online PDF.
   * Injected (not a static import) so the pdf-parse dependency stays in the CLI
   * — this core never grows a PDF dependency. Absent ⇒ a PDF URL is refused as
   * before (the `web_read` tool stays text-only).
   */
  readonly pdfExtractor?: (bytes: Uint8Array) => Promise<string>;
}

export type FetchReadableUrlResult =
  | { readonly ok: true; readonly text: string; readonly title?: string; readonly finalUrl: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Whether a response's `content-type` is text the reader can ground on. HTML /
 * plain text / XML (incl. RSS/Atom `+xml`) / JSON qualify; a binary type
 * (application/pdf, image/*, application/octet-stream, audio, video, fonts,
 * zip) does NOT — decoding it to text yields garbled bytes the model would
 * hallucinate content from and cite to the URL. Exported for direct testing.
 */
export function isReadableContentType(contentType: string): boolean {
  const mime = contentType.toLowerCase().split(";")[0]!.trim();
  if (mime.length === 0) {
    return true; // no declared type → defer to the binary-content sniff
  }
  return mime.startsWith("text/")
    || mime === "application/xhtml+xml"
    || mime === "application/json"
    || mime === "application/ld+json"
    || mime === "application/xml"
    || mime.endsWith("+xml");
}

/** Whether a response's `content-type` declares a PDF. Exported for testing. */
export function isPdfContentType(contentType: string): boolean {
  const mime = contentType.toLowerCase().split(";")[0]!.trim();
  return mime === "application/pdf" || mime === "application/x-pdf";
}

/**
 * Backstop for a binary body served WITHOUT (or with a wrong) content-type: a
 * decoded binary blob carries NUL chars or a high ratio of U+FFFD replacement
 * chars from a lossy UTF-8 decode. Mirrors the `--file` binary refusal.
 */
function looksBinaryText(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (sample.length === 0) {
    return false;
  }
  if (sample.includes("\x00")) {
    return true;
  }
  let replacements = 0;
  for (const char of sample) {
    if (char === "�") {
      replacements += 1;
    }
  }
  return replacements / sample.length > 0.1;
}

export async function fetchReadableUrl(
  rawUrl: string,
  options: FetchReadableUrlOptions = {}
): Promise<FetchReadableUrlResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lookupOpt = options.lookup ? { lookup: options.lookup } : {};

  const guard = await assertPublicHttpUrl(rawUrl, lookupOpt);
  if (!guard.ok) return { ok: false, error: guard.error };

  let response: Response;
  try {
    response = await fetchWithRetry(fetchImpl, guard.url.toString(), {
      timeoutMs: options.timeoutMs ?? 15_000,
      init: { redirect: "follow", headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } },
      ...(options.retryOptions ?? {})
    });
  } catch (error) {
    return { ok: false, error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { ok: false, error: `fetch failed: HTTP ${response.status.toString()}` };

  // A redirect chain can land on a private host the first guard never saw.
  if (response.url && response.url !== guard.url.toString()) {
    const finalGuard = await assertPublicHttpUrl(response.url, lookupOpt);
    if (!finalGuard.ok) return { ok: false, error: `redirected to a blocked host: ${finalGuard.error}` };
  }

  // Refuse a NON-TEXT resource by its declared content-type. A PDF / image /
  // octet-stream URL would otherwise decode to garbled bytes that the model
  // grounds on and cites to the URL — a fabrication. (The caller surfaces this
  // as an honest "I won't ground on it".)
  const declaredType = response.headers.get("content-type") ?? "";
  // An online PDF: read its text via the injected extractor instead of refusing
  // it (an undecodable binary). Only when a `pdfExtractor` is wired — otherwise a
  // PDF falls through to the non-text refusal below, unchanged.
  if (isPdfContentType(declaredType) && options.pdfExtractor) {
    let text: string;
    try {
      text = await options.pdfExtractor(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      return { ok: false, error: `PDF could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: "PDF had no extractable text (scanned / image-only?)" };
    }
    const capped = options.maxChars && trimmed.length > options.maxChars ? trimmed.slice(0, options.maxChars) : trimmed;
    return { ok: true, finalUrl: response.url || guard.url.toString(), text: capped, truncated: capped.length < trimmed.length };
  }
  if (!isReadableContentType(declaredType)) {
    return { ok: false, error: `not a readable text page (content-type: ${declaredType.split(";")[0]!.trim() || "unknown"})` };
  }

  const html = await response.text();
  // Backstop: a binary body served WITH a text/missing content-type still gets
  // caught here, so garbled bytes never reach the model.
  if (looksBinaryText(html)) {
    return { ok: false, error: "not a readable text page (binary content)" };
  }
  const readable = extractReadableText(html, options.maxChars ? { maxChars: options.maxChars } : {});
  return {
    ok: true,
    finalUrl: response.url || guard.url.toString(),
    text: readable.text,
    truncated: readable.truncated,
    ...(readable.title ? { title: readable.title } : {})
  };
}
