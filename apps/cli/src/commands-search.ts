/**
 * `muse search <query>` — direct shell wrapper over the
 * `muse.search` loopback MCP tool. Returns the same SearXNG → DDG
 * fallback chain the agent runtime uses, but without going through
 * a model. Useful for `muse search "X" --json | jq '.results[].url'`
 * pipelines, ad-hoc lookups, and verifying the backend manually
 * after a `muse doctor` failure.
 *
 * Env vars (same as the autoconfigure path):
 *   - `MUSE_SEARXNG_URL` — preferred backend when set
 *   - `MUSE_SEARXNG_ENGINES` — CSV passed through to SearXNG
 *
 * No agent runtime is built; no model is invoked. The Ollama
 * embedding + LLM-judge paths stay out of this command's reach
 * to keep the cold-path < 100 ms.
 */

import { createSearchMcpServer, createLoopbackMcpConnection } from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface SearchOptions {
  readonly limit?: string;
  readonly engines?: string;
  readonly json?: boolean;
}

export function registerSearchCommand(program: Command, io: ProgramIO): void {
  program
    .command("search")
    .description("Web search via the muse.search MCP tool (SearXNG primary, DuckDuckGo fallback)")
    .argument("<query...>", "Query (joined by spaces)")
    .option("--limit <n>", "Max results (default 10, cap 50)")
    .option("--engines <csv>", "CSV passed through to SearXNG, e.g. 'google,brave'. Ignored without MUSE_SEARXNG_URL.")
    .option("--json", "Emit the raw {backend, query, results, total} payload")
    .action(async (queryParts: readonly string[], options: SearchOptions) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        throw new Error("query is required");
      }
      const limit = parseLimit(options.limit, 10, 50);
      const searxngUrl = process.env.MUSE_SEARXNG_URL?.trim();
      const enginesEnv = process.env.MUSE_SEARXNG_ENGINES?.trim();
      const engines = options.engines?.trim() ?? (enginesEnv && enginesEnv.length > 0 ? enginesEnv : undefined);

      const server = createSearchMcpServer({
        maxResults: limit,
        ...(searxngUrl && searxngUrl.length > 0 ? { searxngUrl } : {}),
        ...(engines ? { searxngEngines: engines } : {})
      });
      const connection = createLoopbackMcpConnection(server);
      const result = await connection.callTool!("search", { query });
      const errMsg = (result as { error?: unknown }).error;
      if (typeof errMsg === "string") {
        io.stderr(`(search failed: ${errMsg})\n`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const backend = String((result as { backend?: unknown }).backend ?? "?");
      const total = Number((result as { total?: unknown }).total ?? 0);
      const rows = ((result as { results?: unknown }).results ?? []) as Array<{ title?: string; url?: string; snippet?: string }>;
      io.stdout(`(${total.toString()} result(s) via ${backend})\n\n`);
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i]!;
        const title = stripUntrustedTerminalChars(r.title ?? "").trim() || "(untitled)";
        const url = stripUntrustedTerminalChars(r.url ?? "").trim();
        const snippet = stripUntrustedTerminalChars(r.snippet ?? "").replace(/\s+/gu, " ").trim();
        io.stdout(`  [${(i + 1).toString()}] ${title}\n`);
        if (url.length > 0) io.stdout(`      ${url}\n`);
        if (snippet.length > 0) {
          const trimmed = snippet.length > 200 ? `${snippet.slice(0, 199)}…` : snippet;
          io.stdout(`      ${trimmed}\n`);
        }
        io.stdout("\n");
      }
    });
}

/**
 * Strip C0/C1 control characters from untrusted text before
 * writing to the terminal. Search results come from external HTTP
 * backends (SearXNG or DuckDuckGo HTML scraping); a hostile result
 * could embed ANSI escape sequences (`\x1b[…m`, `\x1b[2J`, `\x1b]…`)
 * to clear the screen, hide text, set window titles, or otherwise
 * confuse the user. We allow newline + tab through other paths and
 * already collapse whitespace; for the unsafe range we just drop
 * the bytes entirely. Treat tool output as untrusted (CLAUDE.md).
 */
export function stripUntrustedTerminalChars(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}

function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(cap, Math.trunc(parsed));
}
