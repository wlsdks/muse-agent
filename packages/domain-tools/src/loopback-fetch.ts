import type { JsonObject } from "@muse/shared";

import { fetchWithRetry, type RetryOptions } from "@muse/mcp-shared";
import type { LoopbackMcpServer } from "@muse/mcp";
import { readString, readJsonObject } from "@muse/mcp";

import { LOCAL_EGRESS_BLOCKED } from "./fetch-readable-url.js";

/**
 * `muse.fetch` loopback MCP server — bounded HTTP GET/HEAD fetcher.
 *
 * Lifted out of `loopback.ts` (lines 852-1005 of the pre-split
 * version) so the URL-allowlist policy and the small fetch-impl
 * injection seam stay co-located. Same public surface:
 * `FetchMcpServerOptions` + `createFetchMcpServer`. Re-exported from
 * `loopback.ts` so the `@muse/mcp` barrel and existing tests keep
 * working without import-site edits.
 */

export interface FetchMcpServerOptions {
  /** Trusted composition posture; false denies each invocation before parsing or I/O. */
  readonly interactiveWebEgressAllowed?: boolean;
  /**
   * Hostnames the fetcher is permitted to reach. Empty by default — opt-in
   * required. The check matches `URL.hostname` exactly (no wildcards). For
   * subdomain support, list each subdomain explicitly.
   */
  readonly allowedHosts: readonly string[];
  /** Hard cap on response body bytes returned to the agent. Default 65,536 (64KB). */
  readonly maxBodyBytes?: number;
  /** Per-request timeout. Default 5,000ms. */
  readonly timeoutMs?: number;
  /** Optional fetch impl override (used in tests). */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Retry-with-backoff for transient failures (429 / 5xx / network reject),
   * shared with the web-watch poller so both surfaces survive the same
   * blips. GET/HEAD are idempotent reads, so a retry can't double-act.
   * Default: 2 retries (see http-retry). `retries: 0` disables it.
   */
  readonly retryOptions?: Pick<RetryOptions, "retries" | "baseDelayMs" | "sleep" | "maxRetryAfterMs">;
}

/**
 * Reference loopback server: bounded HTTP GET / HEAD fetcher. Opt-in,
 * allowlist-required, body-capped. Lets Muse pull a public document or
 * health-check a known URL without giving it free network access.
 *
 * NOT included in `createDefaultLoopbackMcpServers` — operators who want
 * web fetch must construct it explicitly with the hosts they trust.
 */
export function createFetchMcpServer(options: FetchMcpServerOptions): LoopbackMcpServer {
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const maxBodyBytes = options.maxBodyBytes ?? 65_536;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const retryOptions = options.retryOptions ?? {};

  function checkAllowed(rawUrl: string): { readonly allowed: true; readonly url: URL } | { readonly allowed: false; readonly error: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      return { allowed: false, error: `invalid URL: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, error: `unsupported protocol: ${parsed.protocol}` };
    }
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
      return { allowed: false, error: `host '${parsed.hostname}' is not in the configured allowlist` };
    }
    return { allowed: true, url: parsed };
  }

  /**
   * Read the response body chunk-by-chunk, stopping as soon as the
   * accumulated byte count exceeds `maxBodyBytes`. The naive shape
   * `await response.text()` reads the ENTIRE body into a single
   * string before the caller can slice it — a 1 GB response from an
   * allowlisted host (operator trusts the host enough to allow it,
   * but that's partial trust, not unbounded trust) would consume
   * that much memory before the post-truncation `slice(0, cap)`
   * trimmed it back. The reader-cancel path here stops the network
   * read at the cap so the in-flight buffer never grows past it.
   */
  async function readBodyWithCap(
    response: Response
  ): Promise<{ readonly body: string; readonly truncated: boolean }> {
    if (!response.body) {
      return { body: "", truncated: false };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let bytesRead = 0;
    let bodyText = "";
    let truncated = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = maxBodyBytes - bytesRead;
        if (value.byteLength > remaining) {
          const head = value.subarray(0, Math.max(0, remaining));
          // Decode the truncating chunk WITH the stream flag and never flush
          // (the truncated branch skips the final `decode()`), so a partial
          // multi-byte sequence at the cap is dropped, not flushed to U+FFFD —
          // otherwise a Korean body (3 bytes/char) gets a replacement char at
          // the truncation tail ~2/3 of the time.
          bodyText += decoder.decode(head, { stream: true });
          truncated = true;
          await reader.cancel();
          break;
        }
        bodyText += decoder.decode(value, { stream: true });
        bytesRead += value.byteLength;
      }
      if (!truncated) {
        bodyText += decoder.decode();
      }
    } finally {
      try { reader.releaseLock(); } catch { /* released by cancel or natural completion */ }
    }
    return { body: bodyText, truncated };
  }

  /**
   * Fetch with the timeoutMs hard cap covering BOTH the connect+headers
   * phase AND any optional body read. The pre-fix shape returned the
   * Response and cleared the timer immediately, leaving `response.text()`
   * un-bounded — a slow body (or a malicious-but-allowed host streaming
   * a never-ending body) could hang the agent indefinitely past the
   * documented timeout. Keeping the controller's signal active across
   * the body read forces the abort to propagate to the streamed read
   * via fetch's signal contract.
   */
  async function fetchWithOptionalBody(
    url: URL,
    init: RequestInit,
    readBody: boolean
  ): Promise<{
    readonly status: number;
    readonly headers: Headers;
    readonly body: string | undefined;
    readonly truncated: boolean;
  }> {
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const requestInit: RequestInit = timeoutSignal === undefined
      ? { ...init, redirect: "error" }
      : { ...init, redirect: "error", signal: timeoutSignal };
    // fetchWithRetry layers transient-failure retry (429/5xx/network) on
    // top; timeoutMs:0 means retry layer retries only physical transport
    // failures, while timeoutSignal governs both headers and any body read.
    const response = await fetchWithRetry(fetchImpl, url.toString(), {
      ...retryOptions,
      timeoutMs: 0,
      init: requestInit
    });
    if (!readBody) {
      return { body: undefined, headers: response.headers, status: response.status, truncated: false };
    }
    const { body, truncated } = await readBodyWithCap(response);
    return { body, headers: response.headers, status: response.status, truncated };
  }

  function headersToObject(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  return {
    description: "Built-in HTTP GET/HEAD fetcher (loopback MCP, allowlist-bounded).",
    name: "muse.fetch",
    tools: [
      {
        description:
          "GETs the URL and returns { status, headers, body, truncated }. URL must be http/https and the hostname must be in the configured allowlist. Body is truncated at maxBodyBytes (default 64KB). Redirects are NOT followed — a 3xx Location to a different host would otherwise bypass the allowlist; allowlist each hop explicitly if you need a redirect chain.",
        execute: async (args): Promise<JsonObject> => {
          if (options.interactiveWebEgressAllowed === false) {
            return { error: LOCAL_EGRESS_BLOCKED };
          }
          const url = readString(args, "url");
          if (url === undefined) {
            return { error: "url is required" };
          }
          const decision = checkAllowed(url);
          if (!decision.allowed) {
            return { error: decision.error };
          }
          const headerEntries = readJsonObject(args, "headers");
          const requestHeaders: Record<string, string> = {};
          if (headerEntries) {
            for (const [key, value] of Object.entries(headerEntries)) {
              if (typeof value === "string") {
                requestHeaders[key] = value;
              }
            }
          }
          try {
            const result = await fetchWithOptionalBody(decision.url, { headers: requestHeaders, method: "GET" }, true);
            return {
              body: result.body ?? "",
              headers: headersToObject(result.headers),
              status: result.status,
              truncated: result.truncated
            } satisfies JsonObject;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `fetch failed: ${message}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            headers: {
              additionalProperties: { type: "string" },
              description: "Optional request headers, e.g. { \"Authorization\": \"Bearer …\" }.",
              type: "object"
            },
            url: { description: "Absolute http(s) URL to fetch, e.g. 'https://example.com/page' (host must be allowlisted).", type: "string" }
          },
          required: ["url"],
          type: "object"
        },
        name: "get",
        risk: "read"
      },
      {
        description:
          "HEADs the URL and returns { status, headers }. Same allowlist + protocol contract as `get`. Useful for cheap reachability checks without pulling a body.",
        execute: async (args): Promise<JsonObject> => {
          if (options.interactiveWebEgressAllowed === false) {
            return { error: LOCAL_EGRESS_BLOCKED };
          }
          const url = readString(args, "url");
          if (url === undefined) {
            return { error: "url is required" };
          }
          const decision = checkAllowed(url);
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const result = await fetchWithOptionalBody(decision.url, { method: "HEAD" }, false);
            return {
              headers: headersToObject(result.headers),
              status: result.status
            } satisfies JsonObject;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `fetch failed: ${message}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { url: { description: "Absolute http(s) URL to check, e.g. 'https://example.com' (host must be allowlisted).", type: "string" } },
          required: ["url"],
          type: "object"
        },
        name: "head",
        risk: "read"
      }
    ]
  };
}
