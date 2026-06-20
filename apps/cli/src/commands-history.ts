/**
 * `muse history` — unified activity feed across the five
 * personal-JARVIS history stores: reminder firings, proactive
 * notices, fired followups, fired patterns, and prior episodes.
 *
 * Pure file IO over `~/.muse/<store>.json`. Returns the most-recent
 * entries newest-first. Filters: `--kind <one of the five>`,
 * `--since <iso>`, `--limit <n>` (default 20, cap 200), `--json`.
 *
 * Why a dedicated command:
 *   - `muse remind history` → reminder fires only
 *   - `muse proactive list` → proactive notices only
 *   - `muse followup list` → all followups regardless of status
 *   - `muse pattern list` → DETECTED patterns, not fired ones
 *   - `muse episode list` → conversation sessions
 *
 * For a JARVIS user the question "what did you do for me yesterday?"
 * crosses all five. Without this command they'd have to run four
 * separate `list`-shaped commands and merge by hand.
 *
 * The merge itself lives in `@muse/mcp/personal-activity-feed` so
 * the `muse.history.recent` loopback MCP tool reuses the same
 * implementation.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  ACTIVITY_KINDS,
  readActivityFeed,
  type ActivityKind
} from "@muse/mcp";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { formatRelativeTime } from "./human-formatters.js";
import { pluralize } from "./pluralize.js";
import type { ProgramIO } from "./program.js";

interface HistoryOptions {
  readonly kind?: string;
  readonly since?: string;
  readonly limit?: string;
  readonly json?: boolean;
  /**
   * Substring or regex pattern applied to `entry.summary`.
   * Case-insensitive by default unless `--case-sensitive` is set.
   * A bare string searches as a substring; if the value can be
   * compiled as a regex (no flag conflicts), it's used as one.
   */
  readonly grep?: string;
  readonly caseSensitive?: boolean;
}

function envOr(key: string, fallbackName: string): string {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : join(homedir(), ".muse", fallbackName);
}

export function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.min(cap, Math.trunc(parsed));
}

/**
 * Kind → ASCII glyph for the formatted feed, so a quick scroll can
 * pick out reminders vs episodes vs patterns at a glance. Kept
 * ASCII-only (no emoji) per CLAUDE.md; the glyphs stay readable in
 * every terminal (vt100, headless CI, etc.) and never widen the
 * column.
 *
 * Exported so tests can pin the contract and downstream UI can
 * reuse the same mapping when it wants its own scanning glyphs.
 */
export const HISTORY_KIND_ICONS: Readonly<Record<string, string>> = Object.freeze({
  reminder: "(R)",
  proactive: "(P)",
  followup: "(F)",
  pattern: "(*)",
  episode: "(E)"
});

/**
 * Compile `--grep <pattern>` into a `RegExp` we can apply to
 * `entry.summary`. The pattern is tried as a regex first; if that
 * throws (unbalanced metacharacters etc.), we fall back to a
 * literal substring search by escaping the value. Exported for
 * direct unit-test coverage of the boundary cases.
 */
export function compileHistoryGrep(raw: string, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "" : "iu";
  try {
    return new RegExp(raw, flags);
  } catch {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }
}

export function registerHistoryCommand(program: Command, io: ProgramIO): void {
  program
    .command("history")
    .description("Unified activity feed across reminder/proactive/followup/pattern/episode stores (newest first)")
    .option("--kind <one>", "Filter to a single kind: reminder | proactive | followup | pattern | episode")
    .option("--since <iso>", "Drop entries older than this ISO timestamp")
    .option("--limit <n>", "Max entries (default 20, cap 200)")
    .option("--grep <pattern>", "Filter entries whose summary matches the given substring or regex")
    .option("--case-sensitive", "Make --grep case-sensitive (default: case-insensitive)")
    .option("--json", "Emit a structured array instead of the formatted feed")
    .action(async (options: HistoryOptions) => {
      const kindFilter = options.kind?.trim().toLowerCase();
      if (kindFilter && !ACTIVITY_KINDS.has(kindFilter as ActivityKind)) {
        const suggestion = closestCommandName(kindFilter, [...ACTIVITY_KINDS]);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        throw new Error(`--kind must be one of: reminder, proactive, followup, pattern, episode (got '${kindFilter}')${hint}`);
      }
      let sinceMs: number | undefined;
      if (options.since) {
        const parsed = Date.parse(options.since);
        if (!Number.isFinite(parsed)) {
          throw new Error(`--since must be a parseable ISO timestamp (got '${options.since}')`);
        }
        sinceMs = parsed;
      }
      const limit = parseLimit(options.limit, 20, 200);

      // With --grep, read ×10 the cap then post-filter, else a
      // mostly-non-matching history returns zero hits under limit.
      const grepPattern = options.grep
        ? compileHistoryGrep(options.grep, options.caseSensitive === true)
        : undefined;
      const fetchLimit = grepPattern ? Math.min(2000, limit * 10) : limit;
      const candidates = await readActivityFeed({
        episodesFile: envOr("MUSE_EPISODES_FILE", "episodes.json"),
        followupsFile: envOr("MUSE_FOLLOWUPS_FILE", "followups.json"),
        ...(kindFilter ? { kind: kindFilter as ActivityKind } : {}),
        limit: fetchLimit,
        patternsFiredFile: envOr("MUSE_PATTERNS_FIRED_FILE", "patterns-fired.json"),
        proactiveHistoryFile: envOr("MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json"),
        reminderHistoryFile: envOr("MUSE_REMINDER_HISTORY_FILE", "reminder-history.json"),
        ...(sinceMs !== undefined ? { sinceMs } : {})
      });
      const merged = grepPattern
        ? candidates.filter((entry) => grepPattern.test(entry.summary)).slice(0, limit)
        : candidates;

      if (options.json) {
        io.stdout(`${JSON.stringify({ entries: merged, total: merged.length }, null, 2)}\n`);
        return;
      }
      if (merged.length === 0) {
        if (grepPattern) {
          io.stdout(`(no activity matched --grep '${options.grep ?? ""}' — try a broader pattern or drop other filters)\n`);
        } else if (kindFilter) {
          io.stdout(`(no ${kindFilter} activity yet — try \`muse history\` without the filter to see other kinds)\n`);
        } else {
          io.stdout("(no activity yet — JARVIS hasn't fired anything in the configured stores)\n");
        }
        return;
      }
      io.stdout(`Activity (${merged.length.toString()} ${pluralize(merged.length, "entry", "entries")}, newest first):\n\n`);
      const now = new Date();
      for (const entry of merged) {
        const status = entry.status ? ` ${entry.status}` : "";
        const via = entry.providerId
          ? ` via ${entry.providerId}${entry.destination ? `→${entry.destination}` : ""}`
          : "";
        const when = formatRelativeTime(entry.whenIso, now);
        const icon = HISTORY_KIND_ICONS[entry.kind] ?? "(.)";
        const head = `${icon} [${when}] ${entry.kind}${status}${via}`;
        io.stdout(`  ${head}\n`);
        const summary = entry.summary.replace(/\s+/gu, " ").trim();
        const truncated = summary.length > 140 ? `${summary.slice(0, 139)}…` : summary;
        io.stdout(`      ${truncated || "(no summary)"}\n\n`);
      }
    });
}
