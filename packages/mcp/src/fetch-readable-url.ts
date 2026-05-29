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

import { fetchWithRetry, type RetryOptions } from "./http-retry.js";
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
}

export type FetchReadableUrlResult =
  | { readonly ok: true; readonly text: string; readonly title?: string; readonly finalUrl: string; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string };

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

  const html = await response.text();
  const readable = extractReadableText(html, options.maxChars ? { maxChars: options.maxChars } : {});
  return {
    ok: true,
    finalUrl: response.url || guard.url.toString(),
    text: readable.text,
    truncated: readable.truncated,
    ...(readable.title ? { title: readable.title } : {})
  };
}
