import { stripUntrustedTerminalChars, type JsonObject, type JsonValue } from "@muse/shared";

import { fetchWithRetry, type RetryOptions } from "@muse/mcp-shared";
import type { LoopbackMcpServer } from "@muse/mcp";
import { buildJsonToolSchema, readString } from "@muse/mcp";

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
  /**
   * Retry-with-backoff tuning for the (idempotent GET) search fetches —
   * a transient 429 / 5xx / network reject on the DDG or SearXNG read is
   * retried instead of failing the search outright (P19 actuator
   * hardening). Safe because search is read-only; the state-changing
   * web-action path deliberately never retries. Tests inject
   * `{ baseDelayMs: 0, sleep: async () => {} }` to avoid real waits.
   */
  readonly retryOptions?: RetryOptions;
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
  const retryOptions = options.retryOptions ?? {};
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
          "Search the PUBLIC WEB and return up to maxResults rows of { title, url, snippet }. Use when the " +
          "user wants fresh / current / external information that isn't in their own notes and isn't at a " +
          "URL they already gave — e.g. 'search the web for the best noise-cancelling headphones', 'what " +
          "did Apple announce today?', '오늘 환율 검색해줘', '최신 뉴스 찾아봐'. NOT for the user's own notes " +
          "(use knowledge_search) and NOT for reading a specific page whose URL the user already named (use " +
          "web_read / browser_open). " +
          (searxngUrl
            ? "Primary backend: SearXNG (self-hosted, ~200 engines, no API key); falls back to DuckDuckGo HTML. "
            : "Backed by DuckDuckGo's HTML endpoint — no API key required. "),
        domain: "web",
        keywords: ["search", "검색", "찾아봐", "찾아줘", "web", "웹", "google", "구글", "online", "온라인", "latest", "최신", "news", "뉴스", "현재", "지금"],
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query");
          if (!query || query.length === 0) {
            return { error: "query is required" };
          }
          // Unknown / missing time_range falls through unfiltered.
          const timeRange = normaliseTimeRange(readString(args, "time_range"));

          // Path 1 — SearXNG when configured. Fall through to DDG on
          // any failure (HTTP error, JSON parse error, zero results).
          if (searxngUrl) {
            const searxResults = await querySearxng({
              engines: options.searxngEngines,
              fetchImpl,
              maxResults,
              query,
              retryOptions,
              searxngUrl,
              timeoutMs,
              ...(timeRange ? { timeRange } : {})
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
          // DuckDuckGo's df= date filter wants single letters.
          const ddgDf = timeRange === "day"
            ? "d"
            : timeRange === "week"
              ? "w"
              : timeRange === "month"
                ? "m"
                : timeRange === "year"
                  ? "y"
                  : undefined;
          const ddgQs = new URLSearchParams({ q: query });
          if (ddgDf) ddgQs.set("df", ddgDf);
          // Idempotent GET → retry a transient 429 / 5xx / network reject
          // with backoff (Retry-After honoured) before giving up, instead
          // of failing the whole search on a momentary blip.
          let response: Response;
          try {
            response = await fetchWithRetry(fetchImpl, `${endpoint}?${ddgQs.toString()}`, {
              timeoutMs,
              ...retryOptions,
              init: {
                headers: {
                  "accept": "text/html",
                  "user-agent": "muse-search-loopback/1.0"
                }
              }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `search failed: ${message}` };
          }
          if (!response.ok) {
            if (response.status === 429) {
              return {
                error: "search backend rate-limited (429) — back off for a minute, or self-host SearXNG (see docs/setup-local-llm.md)",
                rateLimited: true,
                status: 429
              };
            }
            return { error: `search backend responded ${response.status.toString()}`, status: response.status };
          }
          let html: string;
          try {
            html = await response.text();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { error: `search failed: ${message}` };
          }
          const parsed = parseDuckDuckGoHtml(html, maxResults);
          if (parsed.length === 0) {
            return { error: "parser returned 0 results — backend markup may have shifted" };
          }
          return { backend: "duckduckgo", query, results: parsed as unknown as JsonValue, total: parsed.length };
        },
        inputSchema: buildJsonToolSchema(
          {
            query: { type: "string", description: "What to search the web for, e.g. 'best noise-cancelling headphones 2026'." },
            time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Optional recency filter, e.g. 'day' for today's news." }
          },
          ["query"]
        ),
        name: "search",
        risk: "read"
      }
    ]
  };
}

/**
 * Normalise user-supplied date hints into one of the
 * four SearXNG `time_range` values (`day` / `week` / `month` /
 * `year`). Accepts the natural CLI words (`today`, `week`,
 * `month`, `year`) so `muse search --time today` maps to `day`
 * before reaching the backend. Returns `undefined` for empty /
 * unknown input — the caller treats that as "no filter".
 */
export function normaliseTimeRange(raw: string | undefined): "day" | "week" | "month" | "year" | undefined {
  if (!raw) return undefined;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "today" || normalised === "day" || normalised === "24h") return "day";
  if (normalised === "week" || normalised === "7d") return "week";
  if (normalised === "month" || normalised === "30d") return "month";
  if (normalised === "year" || normalised === "365d") return "year";
  return undefined;
}

interface QuerySearxngArgs {
  readonly searxngUrl: string;
  readonly query: string;
  readonly maxResults: number;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly engines: string | undefined;
  readonly retryOptions: RetryOptions;
  readonly timeRange?: "day" | "week" | "month" | "year";
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
  const params = new URLSearchParams({ format: "json", q: args.query });
  if (args.engines) params.set("engines", args.engines);
  if (args.timeRange) params.set("time_range", args.timeRange);
  let response: Response;
  try {
    // Idempotent GET → retry a transient 429 / 5xx / network reject with
    // backoff before abandoning the preferred backend for the DDG fallback.
    response = await fetchWithRetry(args.fetchImpl, `${args.searxngUrl}/search?${params.toString()}`, {
      timeoutMs: args.timeoutMs,
      ...args.retryOptions,
      init: {
        headers: {
          "accept": "application/json",
          "user-agent": "muse-search-loopback/1.0"
        }
      }
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  try {
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object") return undefined;
    const rows = (payload as { results?: unknown }).results;
    if (!Array.isArray(rows)) return undefined;
    const out: SearchResult[] = [];
    for (const row of rows as readonly SearxngResultRow[]) {
      if (out.length >= args.maxResults) break;
      if (typeof row.url !== "string" || typeof row.title !== "string") continue;
      const snippet = typeof row.content === "string" ? row.content : "";
      out.push({
        snippet: capSnippet(snippet),
        title: sanitizeSearchField(row.title),
        url: sanitizeSearchField(row.url)
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Search hits are attacker-influenceable (a page that ranks for a
 * query, or a compromised SearXNG instance) and this tool's output
 * is fed straight into the model context AND printed to the
 * terminal. Strip ESC / C0 / C1 / DEL then collapse whitespace —
 * the same boundary treatment the notes / feeds / inbox surfaces
 * apply to untrusted text.
 */
function sanitizeSearchField(raw: string): string {
  return stripUntrustedTerminalChars(raw).replace(/\s+/gu, " ").trim();
}

// A search result is for TRIAGE (pick a URL to read), not the full text. Some
// engines return a whole paragraph as the snippet; 10 uncapped paragraphs blow
// the local model's context. Cap to ~280 chars on a word boundary.
const MAX_SNIPPET_CHARS = 280;

function capSnippet(raw: string): string {
  const clean = sanitizeSearchField(raw);
  if (clean.length <= MAX_SNIPPET_CHARS) return clean;
  const slice = clean.slice(0, MAX_SNIPPET_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > MAX_SNIPPET_CHARS - 40 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
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
    const href = sanitizeSearchField(decodeDuckDuckGoRedirect(match[1] ?? ""));
    const title = sanitizeSearchField(stripTags(match[2] ?? ""));
    const snippet = capSnippet(stripTags(match[3] ?? ""));
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
  // URLSearchParams.get() already percent-decodes once; a second decodeURIComponent
  // corrupts a literal `%20` in the target and THROWS URIError on a bare `%`
  // (e.g. `100%-off`), crashing the whole muse.search call.
  return target ? target : raw;
}
