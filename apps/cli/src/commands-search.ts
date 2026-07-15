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

import { createLoopbackMcpConnection } from "@muse/mcp";
import { createSearchMcpServer, normaliseTimeRange } from "@muse/domain-tools";
import { isInteractiveWebEgressAllowed, isLocalOnlyEnabled } from "@muse/model";
import { redactSecretsInText, stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

/**
 * Accepted `--time` spellings, surfaced via `normaliseTimeRange`
 * in @muse/mcp. Kept here as a typed literal so the CLI's
 * typo-suggestion hint covers every form the normaliser knows
 * about (the user-friendly canonical + each shortcut alias).
 */
const TIME_RANGE_FORMS = [
  "today", "day", "24h",
  "week", "7d",
  "month", "30d",
  "year", "365d"
] as const;

// Re-exported so existing call-sites + tests that imported it from
// here keep working. The canonical home is `@muse/shared`.
export { stripUntrustedTerminalChars };

interface SearchOptions {
  readonly limit?: string;
  readonly engines?: string;
  readonly json?: boolean;
  readonly site?: string;
  readonly toNotes?: string;
  readonly overwrite?: boolean;
  /**
   * Date-range hint forwarded to the backend. Accepted: today |
   * day | week | month | year. The MCP server normalises the value
   * before passing it to SearXNG (`time_range=`) or DuckDuckGo
   * (`df=`).
   */
  readonly time?: string;
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
    .option("--time <range>", "Date-range hint forwarded to the backend (today | week | month | year). SearXNG: time_range, DuckDuckGo: df.")
    .option("--json", "Emit the raw {backend, query, results, total} payload")
    .action(async (queryParts: readonly string[], options: SearchOptions) => {
      if (!isInteractiveWebEgressAllowed(process.env)) {
        io.stderr(isLocalOnlyEnabled(process.env)
          ? "muse search: interactive public-web access is blocked by local-only.\n"
          : "muse search: interactive public-web access is disabled by MUSE_WEB_EGRESS.\n");
        process.exitCode = 2;
        return;
      }
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
      // The MCP server silently drops a bad --time (LLM safety);
      // on the CLI a typo is a real user error, so surface it.
      if (options.time && options.time.trim().length > 0) {
        const normalised = normaliseTimeRange(options.time);
        if (!normalised) {
          const suggestion = closestCommandName(options.time.trim(), TIME_RANGE_FORMS);
          const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
          throw new Error(
            `--time must be one of: today, week, month, year ` +
            `(got '${options.time}')${hint}`
          );
        }
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
      const searchStartedAt = Date.now();
      const result = await connection.callTool!("search", {
        query,
        ...(options.time && options.time.trim().length > 0 ? { time_range: options.time.trim() } : {})
      });
      const searchLatencyMs = Date.now() - searchStartedAt;
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
        const { LocalDirNotesProvider } = await import("@muse/domain-tools");
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
          // Scrub title + snippet — external results can quote
          // credentials and the note may sync to a third party.
          // URLs stay verbatim (mangling breaks the clickable link).
          const title = scrubResultText(r.title ?? "") || "(untitled)";
          const url = (r.url ?? "").trim();
          const snippet = scrubResultText(r.snippet ?? "");
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
      io.stdout(`(${total.toString()} result(s) via ${backend} — ${searchLatencyMs.toString()} ms)\n\n`);
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

// Scrub an external web-result title/snippet before it is
// persisted into a markdown note (which feeds RAG and may sync
// to a third party). Strip ESC / C0 / C1 / DEL, collapse
// whitespace (so a multi-line title can't splice a fake `##`
// heading), then redact credential shapes. Parity with the
// console-display path's stripUntrustedTerminalChars.
export function scrubResultText(raw: string): string {
  return redactSecretsInText(stripUntrustedTerminalChars(raw).replace(/\s+/gu, " ").trim());
}

// Absent/blank → fallback. A genuine number is truncated and
// clamped to cap; a non-numeric / below-1 value rejects with an
// actionable message instead of silently returning the default
// (a silently-wrong search result count).
export function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--limit must be an integer in [1, ${cap.toString()}] (got '${raw}')`);
  }
  return Math.min(cap, Math.trunc(parsed));
}
