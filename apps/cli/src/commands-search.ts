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
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

// Re-exported so existing call-sites + tests that imported it from
// here keep working. The canonical home is `@muse/shared` (goal 003).
export { stripUntrustedTerminalChars };

interface SearchOptions {
  readonly limit?: string;
  readonly engines?: string;
  readonly json?: boolean;
  readonly site?: string;
  readonly toNotes?: string;
  readonly overwrite?: boolean;
}

export function registerSearchCommand(program: Command, io: ProgramIO): void {
  program
    .command("search")
    .description("Web search via the muse.search MCP tool (SearXNG primary, DuckDuckGo fallback)")
    .argument("<query...>", "Query (joined by spaces)")
    .option("--limit <n>", "Max results (default 10, cap 50)")
    .option("--engines <csv>", "CSV passed through to SearXNG, e.g. 'google,brave'. Ignored without MUSE_SEARXNG_URL.")
    .option("--site <domain>", "Restrict to one domain (prepends `site:<domain>` to the query — works on both SearXNG and DDG)")
    .option("--to-notes <path>", "Save results as a markdown note under MUSE_NOTES_DIR (path is relative)")
    .option("--overwrite", "When used with --to-notes, allow overwriting an existing note")
    .option("--json", "Emit the raw {backend, query, results, total} payload")
    .action(async (queryParts: readonly string[], options: SearchOptions) => {
      const rawQuery = queryParts.join(" ").trim();
      if (rawQuery.length === 0) {
        throw new Error("query is required");
      }
      // Reject any domain that looks shell-meta-ish — the value
      // becomes part of the query string we send to SearXNG / DDG,
      // and while it's URL-encoded there, sanitising up front
      // prevents `site:foo;bar` style nonsense before it leaves the
      // CLI.
      let query = rawQuery;
      if (options.site && options.site.trim().length > 0) {
        const domain = options.site.trim();
        if (!/^[\w.-]+(?::\d+)?$/u.test(domain)) {
          throw new Error(`--site must be a bare domain (got '${domain}')`);
        }
        query = `site:${domain} ${rawQuery}`;
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

      const backend = String((result as { backend?: unknown }).backend ?? "?");
      const total = Number((result as { total?: unknown }).total ?? 0);
      const rows = ((result as { results?: unknown }).results ?? []) as Array<{ title?: string; url?: string; snippet?: string }>;

      // --to-notes: persist results as a markdown note. Runs before
      // stdout rendering so a single command can both save AND
      // print (when --json is also set, JSON still wins for stdout).
      if (options.toNotes && options.toNotes.trim().length > 0) {
        const { resolveNotesDir } = await import("@muse/autoconfigure");
        const { LocalDirNotesProvider } = await import("@muse/mcp");
        const notesDir = resolveNotesDir(process.env);
        const provider = new LocalDirNotesProvider({ notesDir });
        const lines: string[] = [
          `# Search: ${rawQuery}`,
          "",
          `> via \`${backend}\` — ${total.toString()} result(s)`,
          ""
        ];
        for (let i = 0; i < rows.length; i += 1) {
          const r = rows[i]!;
          const title = (r.title ?? "").trim() || "(untitled)";
          const url = (r.url ?? "").trim();
          const snippet = (r.snippet ?? "").replace(/\s+/gu, " ").trim();
          lines.push(`## ${(i + 1).toString()}. ${title}`);
          if (url.length > 0) lines.push(`<${url}>`);
          if (snippet.length > 0) lines.push("", snippet);
          lines.push("");
        }
        try {
          await provider.save({
            body: lines.join("\n"),
            id: options.toNotes.trim(),
            overwrite: options.overwrite === true,
            title: `Search: ${rawQuery}`.slice(0, 120)
          });
          io.stderr(`(saved ${rows.length.toString()} result(s) to ${options.toNotes.trim()} in ${notesDir})\n`);
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          io.stderr(`(failed to save: ${msg})\n`);
          process.exitCode = 1;
          return;
        }
      }

      if (options.json) {
        io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
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

function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(cap, Math.trunc(parsed));
}
