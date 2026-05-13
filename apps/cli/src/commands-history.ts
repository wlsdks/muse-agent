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

import { formatLocalDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

interface HistoryOptions {
  readonly kind?: string;
  readonly since?: string;
  readonly limit?: string;
  readonly json?: boolean;
}

function envOr(key: string, fallbackName: string): string {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : join(homedir(), ".muse", fallbackName);
}

function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(cap, Math.trunc(parsed));
}

export function registerHistoryCommand(program: Command, io: ProgramIO): void {
  program
    .command("history")
    .description("Unified activity feed across reminder/proactive/followup/pattern/episode stores (newest first)")
    .option("--kind <one>", "Filter to a single kind: reminder | proactive | followup | pattern | episode")
    .option("--since <iso>", "Drop entries older than this ISO timestamp")
    .option("--limit <n>", "Max entries (default 20, cap 200)")
    .option("--json", "Emit a structured array instead of the formatted feed")
    .action(async (options: HistoryOptions) => {
      const kindFilter = options.kind?.trim().toLowerCase();
      if (kindFilter && !ACTIVITY_KINDS.has(kindFilter as ActivityKind)) {
        throw new Error(`--kind must be one of: reminder, proactive, followup, pattern, episode (got '${kindFilter}')`);
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

      const merged = await readActivityFeed({
        episodesFile: envOr("MUSE_EPISODES_FILE", "episodes.json"),
        followupsFile: envOr("MUSE_FOLLOWUPS_FILE", "followups.json"),
        ...(kindFilter ? { kind: kindFilter as ActivityKind } : {}),
        limit,
        patternsFiredFile: envOr("MUSE_PATTERNS_FIRED_FILE", "patterns-fired.json"),
        proactiveHistoryFile: envOr("MUSE_PROACTIVE_HISTORY_FILE", "proactive-history.json"),
        reminderHistoryFile: envOr("MUSE_REMINDER_HISTORY_FILE", "reminder-history.json"),
        ...(sinceMs !== undefined ? { sinceMs } : {})
      });

      if (options.json) {
        io.stdout(`${JSON.stringify({ entries: merged, total: merged.length }, null, 2)}\n`);
        return;
      }
      if (merged.length === 0) {
        io.stdout("(no activity yet — JARVIS hasn't fired anything in the configured stores)\n");
        return;
      }
      io.stdout(`Activity (${merged.length.toString()} entries, newest first):\n\n`);
      for (const entry of merged) {
        const status = entry.status ? ` ${entry.status}` : "";
        const via = entry.providerId
          ? ` via ${entry.providerId}${entry.destination ? `→${entry.destination}` : ""}`
          : "";
        const when = formatLocalDateTime(entry.whenIso);
        const head = `[${when}] ${entry.kind}${status}${via}`;
        io.stdout(`  ${head}\n`);
        const summary = entry.summary.replace(/\s+/gu, " ").trim();
        const truncated = summary.length > 140 ? `${summary.slice(0, 139)}…` : summary;
        io.stdout(`      ${truncated || "(no summary)"}\n\n`);
      }
    });
}
