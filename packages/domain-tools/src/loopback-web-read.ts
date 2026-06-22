import { extractPdfTextWithPdfjs } from "@muse/fs";
import type { JsonObject } from "@muse/shared";

import { fetchWithRetry, type RetryOptions } from "@muse/mcp-shared";
import type { LoopbackMcpServer } from "@muse/mcp";
import { readString } from "@muse/mcp";
import { extractReadableText } from "./web-readable.js";
import { assertPublicHttpUrl, type HostLookup } from "./web-url-guard.js";

export interface WebReadMcpServerOptions {
  /** Hard cap on response body bytes read before extraction. Default 1,048,576 (1MB). */
  readonly maxBytes?: number;
  /** Hard cap on extracted readable-text characters returned to the agent. Default 16,000. */
  readonly maxChars?: number;
  /** Per-attempt timeout passed to the resilient fetch. Default 10,000ms. */
  readonly timeoutMs?: number;
  /** Retry-with-backoff knobs for transient (429 / 5xx / network) failures. */
  readonly retryOptions?: Pick<RetryOptions, "retries" | "baseDelayMs" | "sleep" | "maxRetryAfterMs">;
  /** Injectable fetch (tests / custom transport). */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable DNS lookup for the SSRF guard (tests). */
  readonly lookup?: HostLookup;
  /** PDF text extractor; defaults to the lazy pdfjs implementation (tests inject a fake). */
  readonly extractPdfText?: (data: Buffer) => Promise<string>;
  /** Byte cap for a PDF body (larger than the text cap — PDFs are bigger). Default 10MB. */
  readonly pdfMaxBytes?: number;
  /**
   * Local vision callback for IMAGE URLs (bound by the assembly to its
   * multimodal model). Absent ⇒ an image URL is refused, as before.
   */
  readonly describeImage?: (input: { readonly imageBase64: string; readonly mimeType: string }) => Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
  /** Byte cap for an image body. Default 10MB. */
  readonly imageMaxBytes?: number;
}

function isPdfContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes("application/pdf");
}

const IMAGE_CONTENT_TYPES = /^image\/(png|jpe?g|gif|webp|bmp)\b/u;

function imageMimeFromContentType(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  const m = IMAGE_CONTENT_TYPES.exec(contentType.toLowerCase().trim());
  if (!m) return undefined;
  return contentType.toLowerCase().includes("jpg") ? "image/jpeg" : `image/${(m[1] ?? "").replace("jpg", "jpeg")}`;
}

async function readBytesCapped(response: Response, maxBytes: number): Promise<{ readonly bytes: Buffer; readonly truncated: boolean }> {
  const buf = Buffer.from(await response.arrayBuffer());
  return buf.byteLength > maxBytes
    ? { bytes: buf.subarray(0, maxBytes), truncated: true }
    : { bytes: buf, truncated: false };
}

function isReadableContentType(contentType: string | null): boolean {
  if (contentType === null) return true;
  const value = contentType.toLowerCase();
  return value.startsWith("text/") || value.includes("html") || value.includes("xml") || value.includes("json");
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<{ readonly body: string; readonly truncated: boolean }> {
  if (!response.body) {
    return { body: "", truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytesRead = 0;
  let body = "";
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        body += decoder.decode(value.subarray(0, Math.max(0, remaining)));
        truncated = true;
        await reader.cancel();
        break;
      }
      body += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    if (!truncated) body += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* released by cancel / completion */ }
  }
  return { body, truncated };
}

/**
 * `muse.web` loopback MCP server — one read-only tool that pulls a public
 * web page and returns its readable text. Default-on perception: lets the
 * local model answer "summarize this URL" without a running Chrome and
 * without the per-host allowlist `muse.fetch` requires. SSRF-guarded
 * (public hosts only) and resilient to transient upstream failures.
 */
export function createWebReadMcpServer(options: WebReadMcpServerOptions = {}): LoopbackMcpServer {
  const maxBytes = options.maxBytes ?? 1_048_576;
  const maxChars = options.maxChars ?? 16_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const extractPdf = options.extractPdfText ?? extractPdfTextWithPdfjs;
  const pdfMaxBytes = options.pdfMaxBytes ?? 10 * 1024 * 1024;
  const imageMaxBytes = options.imageMaxBytes ?? 10 * 1024 * 1024;

  return {
    description: "Built-in readable web-page reader (loopback MCP, SSRF-guarded, public hosts only).",
    name: "muse.web",
    tools: [
      {
        description:
          "Fetch a web page by URL and return its readable text { url, title, text, truncated } with HTML stripped. " +
          "Use when the user gives a URL to read, summarize, or answer questions about, e.g. 'summarize https://example.com/post' " +
          "or 'what does https://example.com/page say'. Do NOT use for a keyword web search with no URL (use search), " +
          "to download a file/binary, or for a page that needs a logged-in browser session.",
        domain: "web",
        execute: async (args): Promise<JsonObject> => {
          const rawUrl = readString(args, "url");
          if (rawUrl === undefined || rawUrl.trim().length === 0) {
            return { error: "url is required" };
          }
          const guard = await assertPublicHttpUrl(rawUrl.trim(), options.lookup ? { lookup: options.lookup } : {});
          if (!guard.ok) {
            return { error: guard.error };
          }
          let response: Response;
          try {
            response = await fetchWithRetry(fetchImpl, guard.url.toString(), {
              timeoutMs,
              init: { redirect: "follow", headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } },
              ...(options.retryOptions ?? {})
            });
          } catch (error) {
            return { error: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (!response.ok) {
            return { error: `fetch failed: HTTP ${response.status}`, status: response.status };
          }
          // A redirect chain can land on a private host the first guard never saw.
          if (response.url && response.url !== guard.url.toString()) {
            const finalGuard = await assertPublicHttpUrl(response.url, options.lookup ? { lookup: options.lookup } : {});
            if (!finalGuard.ok) {
              return { error: `redirected to a blocked host: ${finalGuard.error}` };
            }
          }
          const contentType = response.headers.get("content-type");
          // A PDF URL ("summarize this report.pdf link") is extracted locally
          // via pdfjs rather than rejected as non-text.
          if (isPdfContentType(contentType)) {
            const { bytes, truncated: pdfTruncated } = await readBytesCapped(response, pdfMaxBytes);
            try {
              const pdfText = await extractPdf(bytes);
              const capped = pdfText.length > maxChars;
              return {
                text: capped ? pdfText.slice(0, maxChars) : pdfText,
                title: "",
                truncated: capped || pdfTruncated,
                url: response.url || guard.url.toString()
              } satisfies JsonObject;
            } catch (error) {
              return { error: `could not extract PDF text: ${error instanceof Error ? error.message : String(error)}` };
            }
          }
          // An image URL ("what's in this chart.png?") is described by the local
          // vision model — the web analog of file_read reading a local image.
          const imageMime = imageMimeFromContentType(contentType);
          if (imageMime !== undefined) {
            if (!options.describeImage) {
              return { error: `image URL needs the local vision model, not available in this run (content-type: ${contentType})` };
            }
            const { bytes } = await readBytesCapped(response, imageMaxBytes);
            const described = await options.describeImage({ imageBase64: bytes.toString("base64"), mimeType: imageMime });
            if (!described.ok || !described.text) {
              return { error: described.error ?? "the vision model could not read the image" };
            }
            return { text: described.text, title: "", truncated: false, url: response.url || guard.url.toString() } satisfies JsonObject;
          }
          if (!isReadableContentType(contentType)) {
            return { error: `not a readable text page (content-type: ${contentType})` };
          }
          const { body, truncated: bodyTruncated } = await readBodyCapped(response, maxBytes);
          const extracted = extractReadableText(body, { maxChars });
          return {
            text: extracted.text,
            title: extracted.title ?? "",
            truncated: extracted.truncated || bodyTruncated,
            url: response.url || guard.url.toString()
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            url: { description: "Absolute http(s) URL of the page to read, e.g. 'https://example.com/article'.", type: "string" }
          },
          required: ["url"],
          type: "object"
        },
        keywords: ["read", "article", "summarize", "summary", "content", "page", "url", "open", "기사", "읽어", "본문", "내용", "요약"],
        name: "read",
        risk: "read"
      }
    ]
  };
}
