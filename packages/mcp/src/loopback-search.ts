import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer } from "./loopback.js";
import { buildJsonToolSchema, readString } from "./loopback-helpers.js";

/**
 * `muse.search` loopback MCP server — model-agnostic web search.
 *
 * Native server-side `web_search` exists on OpenAI / Anthropic /
 * Gemini, but local providers (Qwen, Llama, etc.) don't have it.
 * A JARVIS-class assistant running on a 2B local model still needs
 * to answer "what's the weather in Seoul?" or "what did Apple
 * announce today?". This tool fills the gap with two backends,
 * picked in order:
 *
 *   1. `searxngUrl` (preferred when set, e.g. `MUSE_SEARXNG_URL=https://my-searxng.local`)
 *      — JSON API over a self-hosted SearXNG aggregator. 200+
 *      upstream engines, no API key, no rate-limit beyond what the
 *      operator's instance enforces. CLAUDE.md's "provider-neutral"
 *      stance fits the SearXNG-self-hosted path well.
 *   2. DuckDuckGo HTML scrape (default, no setup required) —
 *      `https://html.duckduckgo.com/html/`. Brittle (HTML can shift)
 *      and rate-limited; lives as the zero-config fallback for
 *      installs without a SearXNG instance running.
 *
 * Bounded by:
 *   - `maxResults` (default 10): hard cap on returned rows
 *   - `timeoutMs` (default 8s): per-request timeout
 *   - SearXNG JSON parse is strict — non-object responses or
 *     missing `results` array → fall through to DDG.
 *   - DDG HTML parse is regex-based; 0 parsed rows → explicit
 *     `{ error: "parser returned 0 results" }`.
 */

export interface SearchMcpServerOptions {
  /** Max rows returned to the agent. Default 10. */
  readonly maxResults?: number;
  /** Per-request timeout. Default 8,000ms. */
  readonly timeoutMs?: number;
  /** Optional fetch impl override (used in tests). */
  readonly fetch?: typeof globalThis.fetch;
  /** Override the upstream DDG endpoint (test injection / mirror). */
  readonly endpoint?: string;
  /**
   * Optional SearXNG base URL (e.g. `http://localhost:8888` or a
   * private instance). When set, every search request hits this
   * first; on transport / parse failure the DDG fallback runs.
   * No API key required — SearXNG is open-source and aggregates
   * 200+ upstream search engines locally.
   */
  readonly searxngUrl?: string;
  /**
   * Optional comma-separated engines list forwarded to SearXNG
   * (e.g. `"google,brave,duckduckgo"`). Defaults to whatever the
   * SearXNG instance's settings.yml allows. Ignored when
   * `searxngUrl` is unset.
   */
  readonly searxngEngines?: string;
}

const DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Built-in web search server. Included in
 * `createDefaultLoopbackMcpServers` so every Muse install gets
 * one — bring-your-own-key search backends can be wired in by the
 * external MCP config when an operator wants a paid provider.
 */
export function createSearchMcpServer(options: SearchMcpServerOptions = {}): LoopbackMcpServer {
  const maxResults = Math.max(1, Math.min(50, options.maxResults ?? 10));
  const timeoutMs = options.timeoutMs ?? 8_000;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const searxngUrl = options.searxngUrl?.trim().replace(/\/+$/u, "");

  const backendDescription = searxngUrl
    ? `Built-in web search (loopback MCP, SearXNG ${searxngUrl} primary, DuckDuckGo HTML fallback, no API key).`
    : "Built-in web search (loopback MCP, DuckDuckGo HTML backend, no API key).";

  return {
    description: backendDescription,
    name: "muse.search",
    tools: [
      {
        description:
          "Search the public web. Returns up to maxResults rows of { title, url, snippet }. " +
          (searxngUrl
            ? "Primary backend: SearXNG (self-hosted aggregator, ~200 upstream engines, no API key). Falls back to DuckDuckGo HTML if SearXNG fails. "
            : "Backed by DuckDuckGo's HTML endpoint — no API key required. ") +
          "Use this when the model doesn't have a native web_search tool (local Qwen / Llama / etc.).",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query");
          if (!query || query.length === 0) {
            return { error: "query is required" };
          }

          // Path 1 — SearXNG when configured. Fall through to DDG on
          // any failure (HTTP error, JSON parse error, zero results).
          if (searxngUrl) {
            const searxResults = await querySearxng({
              engines: options.searxngEngines,
              fetchImpl,
              maxResults,
              query,
              searxngUrl,
              timeoutMs
            });
            if (searxResults !== undefined && searxResults.length > 0) {
              return {
                backend: "searxng",
                query,
                results: searxResults as unknown as JsonValue,
                total: searxResults.length
              };
            }
            // searxResults undefined → transport/parse failure; [] → zero hits.
            // Both fall through to DDG so the agent still gets a chance at results.
          }

          // Path 2 — DuckDuckGo HTML fallback (or sole backend when
          // searxngUrl is unset).
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let html: string;
          try {
            const response = await fetchImpl(`${endpoint}?q=${encodeURIComponent(query)}`, {
              headers: {
                "accept": "text/html",
                "user-agent": "muse-search-loopback/1.0"
              },
              signal: controller.signal
            });
            if (!response.ok) {
              return { error: `search backend responded ${response.status.toString()}` };
            }
            html = await response.text();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `search failed: ${message}` };
          } finally {
            clearTimeout(timer);
          }
          const parsed = parseDuckDuckGoHtml(html, maxResults);
          if (parsed.length === 0) {
            return { error: "parser returned 0 results — backend markup may have shifted" };
          }
          return { backend: "duckduckgo", query, results: parsed as unknown as JsonValue, total: parsed.length };
        },
        inputSchema: buildJsonToolSchema({ query: { type: "string" } }, ["query"]),
        name: "search",
        risk: "read"
      }
    ]
  };
}

interface QuerySearxngArgs {
  readonly searxngUrl: string;
  readonly query: string;
  readonly maxResults: number;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly engines: string | undefined;
}

interface SearxngResultRow {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
}

/**
 * Hit `<searxngUrl>/search?q=...&format=json`. SearXNG returns
 * `{ results: [{title, url, content, ...}], …}`. Returns
 * `undefined` on any transport / parse failure so the caller can
 * fall back to DDG; returns `[]` when SearXNG responded cleanly
 * with zero hits (also falls back so the user isn't left empty-handed).
 */
async function querySearxng(args: QuerySearxngArgs): Promise<readonly SearchResult[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const params = new URLSearchParams({ format: "json", q: args.query });
  if (args.engines) params.set("engines", args.engines);
  try {
    const response = await args.fetchImpl(`${args.searxngUrl}/search?${params.toString()}`, {
      headers: {
        "accept": "application/json",
        "user-agent": "muse-search-loopback/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object") return undefined;
    const rows = (payload as { results?: unknown }).results;
    if (!Array.isArray(rows)) return undefined;
    const out: SearchResult[] = [];
    for (const row of rows as readonly SearxngResultRow[]) {
      if (out.length >= args.maxResults) break;
      if (typeof row.url !== "string" || typeof row.title !== "string") continue;
      const snippet = typeof row.content === "string" ? row.content : "";
      out.push({ snippet: snippet.replace(/\s+/gu, " ").trim(), title: row.title.trim(), url: row.url });
    }
    return out;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Regex-extract result rows from DuckDuckGo's html.duckduckgo.com/html/
 * markup. Two stable class names since 2019:
 *   - `<a class="result__a" href="…">title</a>`
 *   - `<a class="result__snippet" …>snippet</a>`
 * One full pattern per result block keeps title/url/snippet aligned —
 * a flat per-class sweep would drift if any field is missing.
 */
export function parseDuckDuckGoHtml(html: string, max: number): readonly SearchResult[] {
  const out: SearchResult[] = [];
  const blockRe = /<a\s+rel="nofollow"\s+class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gu;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null && out.length < max) {
    const href = decodeDuckDuckGoRedirect(match[1] ?? "");
    const title = stripTags(match[2] ?? "").trim();
    const snippet = stripTags(match[3] ?? "").trim();
    if (href && title) {
      out.push({ snippet, title, url: href });
    }
  }
  return out;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, "").replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/&#x27;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/\s+/gu, " ");
}

/**
 * DDG wraps every result href in `//duckduckgo.com/l/?uddg=<encoded>&…`.
 * Unwrap the `uddg` query param so the model gets the canonical URL.
 */
function decodeDuckDuckGoRedirect(raw: string): string {
  if (!raw.startsWith("//duckduckgo.com/l/") && !raw.startsWith("https://duckduckgo.com/l/")) {
    return raw;
  }
  const queryStart = raw.indexOf("?");
  if (queryStart < 0) return raw;
  const params = new URLSearchParams(raw.slice(queryStart + 1));
  const target = params.get("uddg");
  return target ? decodeURIComponent(target) : raw;
}
