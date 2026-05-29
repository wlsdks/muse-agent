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
  planEpisodeConsolidation,
  readEpisodes,
  recurringThemes,
  removeEpisode,
  serializeEpisode,
  writeEpisodes,
  type PersistedEpisode
} from "@muse/mcp";
import { resolveEpisodesFile } from "@muse/autoconfigure";
import { copyFile } from "node:fs/promises";
import type { Command } from "commander";

import { embed } from "./embed.js";
import {
  buildEpisodeIndex,
  defaultEpisodeIndexFile,
  loadEpisodeIndex,
  saveEpisodeIndex
} from "./episode-index.js";
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
    .command("search")
    .description("Search episodes by substring (default) or by LLM relevance judge with --llm-judge")
    .argument("<query...>", "Query (joined by spaces)")
    .option("--user <userId>", "Filter to a single user")
    .option("--limit <n>", "Max matches (default 10, cap 50)")
    .option("--llm-judge", "Ask the model to pick relevant ids from the full episode list (catches paraphrase recall; one extra LLM call)")
    .option("--json", "Print the raw payload")
    .action(async (queryParts: readonly string[], options: { readonly user?: string; readonly limit?: string; readonly llmJudge?: boolean } & SharedOptions) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        throw new Error("query is required");
      }
      const limit = parseLimit(options.limit, 10, 50);
      const userFilter = options.user?.trim();
      const all = await readEpisodes(localEpisodesFile());
      const scoped = userFilter ? all.filter((e) => e.userId === userFilter) : all;
      let matches: readonly PersistedEpisode[];
      let mode: "substring" | "llm-judge";
      if (options.llmJudge) {
        mode = "llm-judge";
        matches = await runLlmJudgeFromCli(scoped, query, limit);
      } else {
        mode = "substring";
        const needle = query.toLowerCase();
        matches = scoped
          .filter((entry) => {
            if (entry.summary.toLowerCase().includes(needle)) return true;
            if (entry.topics) {
              for (const topic of entry.topics) {
                if (topic.toLowerCase().includes(needle)) return true;
              }
            }
            return false;
          })
          .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
          .slice(0, limit);
      }
      const payload = {
        episodes: matches.map(serializeEpisode),
        mode,
        query,
        total: matches.length,
        ...(userFilter ? { userId: userFilter } : {})
      };
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      io.stdout(formatEpisodeList(matches, userFilter));
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

  episode
    .command("themes")
    .description("Topics recurring across multiple past sessions — a reflection over episodic memory")
    .option("--user <userId>", "Filter to a single user. Default: every entry in the file.")
    .option("--min-count <n>", "Min sessions a topic must appear in (default 2)")
    .option("--limit <n>", "Max themes to show (default 10, cap 100)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly user?: string; readonly minCount?: string; readonly limit?: string } & SharedOptions) => {
      const minCount = parseLimit(options.minCount, 2, 100);
      const limit = parseLimit(options.limit, 10, 100);
      const userFilter = options.user?.trim();
      const all = await readEpisodes(localEpisodesFile());
      const scoped = userFilter ? all.filter((entry) => entry.userId === userFilter) : all;
      const themes = recurringThemes(scoped, { minCount, limit });
      if (options.json) {
        io.stdout(`${JSON.stringify({ themes, total: themes.length, ...(userFilter ? { userId: userFilter } : {}) }, null, 2)}\n`);
        return;
      }
      if (themes.length === 0) {
        io.stdout(`No topic recurs across ${minCount.toString()}+ sessions yet.\n`);
        return;
      }
      io.stdout(`Recurring themes (${themes.length.toString()}):\n`);
      for (const theme of themes) {
        io.stdout(`  ${theme.count.toString()}×  ${theme.topic}  (last: ${shortDateTime(theme.lastSeen)})\n`);
      }
    });

  episode
    .command("consolidate")
    .description("Find near-duplicate past sessions; --apply archives the redundant ones (keeps the richer)")
    .option("--threshold <n>", "Summary similarity 0..1 to treat as duplicate (default 0.85)")
    .option("--user <userId>", "Filter to a single user")
    .option("--apply", "Remove the archived duplicates (a .bak backup is written first)")
    .option("--json", "Print the raw plan instead of the formatted list")
    .action(async (options: { readonly threshold?: string; readonly user?: string; readonly apply?: boolean } & SharedOptions) => {
      const threshold = options.threshold === undefined ? 0.85 : Number(options.threshold);
      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
        throw new Error(`--threshold must be a number in (0, 1] (got '${options.threshold ?? ""}')`);
      }
      const file = localEpisodesFile();
      const all = await readEpisodes(file);
      const userFilter = options.user?.trim();
      const scoped = userFilter ? all.filter((entry) => entry.userId === userFilter) : all;
      const plan = planEpisodeConsolidation(scoped, { threshold });
      if (options.json) {
        io.stdout(`${JSON.stringify({ applied: Boolean(options.apply), plan }, null, 2)}\n`);
        return;
      }
      if (plan.length === 0) {
        io.stdout(`No near-duplicate episodes at threshold ${threshold.toString()}.\n`);
        return;
      }
      io.stdout(`${plan.length.toString()} near-duplicate episode(s):\n`);
      for (const pair of plan) {
        io.stdout(`  keep [${pair.kept.slice(0, 8)}]  ←  archive [${pair.archived.slice(0, 8)}]  (sim ${pair.similarity.toString()})\n`);
      }
      if (!options.apply) {
        io.stdout(`\nRun with --apply to remove the archived ones (a backup is written to ${file}.bak first).\n`);
        return;
      }
      const drop = new Set(plan.map((pair) => pair.archived));
      await copyFile(file, `${file}.bak`).catch(() => undefined);
      await writeEpisodes(file, all.filter((entry) => !drop.has(entry.id)));
      io.stdout(`\nArchived ${drop.size.toString()} duplicate(s). Backup: ${file}.bak\n`);
    });

  // Mirrors the notes-index pipeline so `muse recall` shares one
  // cosine implementation across notes + episodes.
  episode
    .command("reindex")
    .description("Embed every episode summary into ~/.muse/episodes-index.json")
    .option("--embed-model <tag>", "Embedding model id (default 'nomic-embed-text')", "nomic-embed-text")
    .option("--force", "Re-embed every entry even when an existing index could be reused")
    .option("--json", "Emit a structured summary")
    .action(async (options: { readonly embedModel?: string; readonly force?: boolean; readonly json?: boolean }) => {
      const model = options.embedModel ?? "nomic-embed-text";
      const indexFile = defaultEpisodeIndexFile();
      const previous = await loadEpisodeIndex(indexFile);
      const episodes = await readEpisodes(localEpisodesFile());
      let summary;
      try {
        summary = await buildEpisodeIndex({
          episodes,
          embedFn: (text) => embed(text, model),
          previous,
          model,
          nowIso: new Date().toISOString(),
          force: options.force === true
        });
      } catch (cause) {
        io.stderr(
          `muse episode reindex: embedding failed — ` +
          `is Ollama running with '${model}' pulled? ` +
          `(underlying: ${cause instanceof Error ? cause.message : String(cause)})\n`
        );
        process.exitCode = 1;
        return;
      }
      await saveEpisodeIndex(indexFile, summary.index);
      const payload = {
        indexPath: indexFile,
        total: summary.index.entries.length,
        embedded: summary.embedded,
        skipped: summary.skipped
      };
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      io.stdout(
        `Indexed ${payload.total.toString()} episode(s) into ${indexFile} ` +
        `(embedded ${summary.embedded.toString()}, reused ${summary.skipped.toString()})\n`
      );
    });
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

/**
 * `--llm-judge` mode: send the query + every candidate episode's
 * (id, date, summary, topics) to the configured local model and
 * parse a JSON array of ids back. Lazy-import the assembly so the
 * other subcommands don't pay the autoconfigure boot cost.
 *
 * Throws when no model is wired so the user gets a clean
 * "configure MUSE_MODEL first" message instead of silently
 * degrading to substring.
 */
async function runLlmJudgeFromCli(
  candidates: readonly PersistedEpisode[],
  query: string,
  limit: number
): Promise<readonly PersistedEpisode[]> {
  if (candidates.length === 0) return [];
  const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
  const assembly = createMuseRuntimeAssembly();
  if (!assembly.modelProvider || !assembly.defaultModel) {
    throw new Error("--llm-judge requires MUSE_MODEL (and a wired model provider). Set MUSE_MODEL and re-run.");
  }
  const sorted = [...candidates].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
  const lines: string[] = [];
  for (const ep of sorted) {
    const topicSuffix = ep.topics && ep.topics.length > 0 ? ` [${ep.topics.join(", ")}]` : "";
    lines.push(`[${ep.id}] ${ep.endedAt.slice(0, 10)}: ${ep.summary.replace(/\s+/gu, " ").trim()}${topicSuffix}`);
  }
  const systemPrompt =
    "You are an episode selector. Return STRICT JSON: a single array of episode id strings, ordered by relevance. " +
    "NEVER invent ids that were not in the input. NEVER include explanatory text. Return [] when nothing meaningfully matches.";
  const userMessage = `Query: ${query}\n\nEpisodes:\n${lines.join("\n")}\n\nReturn at most ${limit.toString()} ids.`;

  const response = await assembly.modelProvider.generate({
    maxOutputTokens: 320,
    messages: [
      { content: systemPrompt, role: "system" },
      { content: userMessage, role: "user" }
    ],
    model: assembly.defaultModel,
    temperature: 0
  });
  const ids = parseLlmJudgeIds((response.output ?? "").trim());
  const byId = new Map(sorted.map((ep) => [ep.id, ep] as const));
  const seen = new Set<string>();
  const out: PersistedEpisode[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const ep = byId.get(id);
    if (!ep) continue;
    seen.add(id);
    out.push(ep);
    if (out.length >= limit) break;
  }
  return out;
}

function parseLlmJudgeIds(raw: string): readonly string[] {
  const first = raw.indexOf("[");
  if (first < 0) return [];
  let depth = 0;
  let body = "";
  for (let i = first; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) { body = raw.slice(first, i + 1); break; }
    }
  }
  if (!body) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
}
