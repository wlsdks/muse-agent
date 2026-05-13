/**
 * `muse episode` command group — visibility + control over the
 * agent's auto-captured prior-session summaries.
 *
 *   - `muse episode list [--user X] [--limit N]`   — newest first
 *   - `muse episode show <id|prefix>`              — full record
 *   - `muse episode remove <id|prefix>`            — drop one
 *   - `muse episode clear [--yes]`                 — drop all
 *
 * Captured automatically at REPL exit when
 * `MUSE_EPISODIC_MEMORY_ENABLED=true`; surfaced in the persona
 * system prompt by `buildMusePersona`. This CLI is the audit /
 * cleanup window — the user can `cat ~/.muse/episodes.json`
 * too, but the prefix-match resolver + structured output here is
 * less error-prone.
 */

import {
  clearEpisodes,
  readEpisodes,
  removeEpisode,
  serializeEpisode,
  type PersistedEpisode
} from "@muse/mcp";
import { resolveEpisodesFile } from "@muse/autoconfigure";
import type { Command } from "commander";

import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

interface SharedOptions {
  readonly json?: boolean;
}

function localEpisodesFile(): string {
  return resolveEpisodesFile(process.env as Record<string, string | undefined>);
}

export function registerEpisodeCommands(program: Command, io: ProgramIO): void {
  const episode = program
    .command("episode")
    .description("Self-captured prior-session summaries (auto-written at REPL exit when MUSE_EPISODIC_MEMORY_ENABLED=true)");

  episode
    .command("list")
    .description("List episodes (newest first by endedAt)")
    .option("--user <userId>", "Filter to a single user. Default: every entry in the file.")
    .option("--limit <n>", "Max entries (default 10, cap 200)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly user?: string; readonly limit?: string } & SharedOptions) => {
      const limit = parseLimit(options.limit, 10, 200);
      const userFilter = options.user?.trim();
      const all = await readEpisodes(localEpisodesFile());
      const scoped = userFilter ? all.filter((e) => e.userId === userFilter) : all;
      const sorted = [...scoped]
        .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
        .slice(0, limit);
      const payload = {
        episodes: sorted.map(serializeEpisode),
        total: sorted.length,
        ...(userFilter ? { userId: userFilter } : {})
      };
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      io.stdout(formatEpisodeList(sorted, userFilter));
    });

  episode
    .command("show")
    .description("Show a single episode by id (prefix-match allowed)")
    .argument("<id>", "Episode id or unambiguous prefix")
    .option("--json", "Print the full record as JSON")
    .action(async (id: string, options: SharedOptions) => {
      const all = await readEpisodes(localEpisodesFile());
      const resolved = resolveEpisodeId(id, all);
      const record = all.find((entry) => entry.id === resolved);
      if (!record) {
        throw new Error(`No episode found with id "${id}"`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(serializeEpisode(record), null, 2)}\n`);
        return;
      }
      io.stdout(formatEpisodeDetail(record));
    });

  episode
    .command("remove")
    .description("Drop a single episode (irreversible)")
    .argument("<id>", "Episode id or unambiguous prefix")
    .option("--json", "Print { removed, id } on success")
    .action(async (id: string, options: SharedOptions) => {
      const file = localEpisodesFile();
      const all = await readEpisodes(file);
      const resolved = resolveEpisodeId(id, all);
      const ok = await removeEpisode(file, resolved);
      if (!ok) {
        throw new Error(`No episode found with id "${id}"`);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ id: resolved, removed: true }, null, 2)}\n`);
        return;
      }
      io.stdout(`Removed [${resolved.slice(0, 12)}]\n`);
    });

  episode
    .command("clear")
    .description("Drop every episode from the store (irreversible — requires --yes)")
    .option("--yes", "Confirm destructive intent. Without this flag the command refuses.")
    .option("--json", "Print { cleared, removed } on success")
    .action(async (options: { readonly yes?: boolean } & SharedOptions) => {
      if (!options.yes) {
        throw new Error("Refusing to clear without --yes (this is irreversible — pass --yes to confirm)");
      }
      const file = localEpisodesFile();
      const before = await readEpisodes(file);
      await clearEpisodes(file);
      if (options.json) {
        io.stdout(`${JSON.stringify({ cleared: true, removed: before.length }, null, 2)}\n`);
        return;
      }
      io.stdout(`Cleared ${before.length.toString()} episode(s)\n`);
    });
}

function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(cap, Math.trunc(parsed));
}

function resolveEpisodeId(input: string, all: readonly PersistedEpisode[]): string {
  if (all.some((entry) => entry.id === input)) {
    return input;
  }
  const matches = all.filter((entry) => entry.id.startsWith(input));
  if (matches.length === 0) {
    throw new Error(`No episode found with id "${input}"`);
  }
  if (matches.length > 1) {
    const previews = matches.slice(0, 5).map((entry) => entry.id.slice(0, 20)).join(", ");
    throw new Error(`Ambiguous episode id "${input}" — matches ${matches.length.toString()} (${previews}…)`);
  }
  return matches[0]!.id;
}

function formatEpisodeList(records: readonly PersistedEpisode[], userFilter: string | undefined): string {
  if (records.length === 0) {
    return userFilter
      ? `No episodes for user "${userFilter}".\n`
      : "No episodes captured yet.\n";
  }
  const lines = records.map((entry) => {
    const id = entry.id.slice(0, 12);
    const when = shortDateTime(entry.endedAt);
    const summary = compactOneLine(entry.summary, 100);
    return `[${id}] ${when} ${entry.userId} — ${summary}`;
  });
  return `${lines.join("\n")}\n`;
}

function formatEpisodeDetail(record: PersistedEpisode): string {
  const lines = [
    `id:         ${record.id}`,
    `userId:     ${record.userId}`,
    `startedAt:  ${shortDateTime(record.startedAt)} (${record.startedAt})`,
    `endedAt:    ${shortDateTime(record.endedAt)} (${record.endedAt})`,
    `summary:    ${record.summary}`
  ];
  if (record.topics && record.topics.length > 0) {
    lines.push(`topics:     ${record.topics.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function compactOneLine(value: string, maxChars: number): string {
  const single = value.replace(/\s+/gu, " ").trim();
  if (single.length <= maxChars) return single;
  return `${single.slice(0, maxChars - 1)}…`;
}
