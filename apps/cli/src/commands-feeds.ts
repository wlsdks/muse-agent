/**
 * `muse feeds` — RSS / Atom ingest (goal 092).
 *
 *   muse feeds add <url> [--id <alias>] [--name <name>]
 *   muse feeds list [--json]
 *   muse feeds remove <id>
 *   muse feeds refresh [--id <id>]
 *   muse feeds today [--hours <n>] [--json]
 *
 * `~/.muse/feeds.json` carries every feed's url + cached entries
 * so `today` doesn't need network. Pure XML parsing via
 * `fast-xml-parser` (MIT). Supports both `file://` URLs (for
 * dogfood + offline tests) and `http(s)://`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import {
  compareFeedEntriesNewestFirst,
  defaultFeedsFile,
  filterRecentFeedEntries,
  mergeFeedEntries,
  parseFeedBody,
  readFeedsStore,
  writeFeedsStore,
  type FeedEntry,
  type FeedRecord,
  type FeedsStore
} from "./feeds-store.js";
import type { ProgramIO } from "./program.js";

/**
 * Goal 092 — fetch the feed body. Supports `file://` so the
 * dogfood can plant a fixture and exercise the parser without
 * network. Exported for direct test coverage.
 */
export async function loadFeedBody(url: string): Promise<string> {
  if (url.startsWith("file://")) {
    return readFile(fileURLToPath(url), "utf8");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`feed fetch ${url} returned ${response.status.toString()}`);
  }
  return response.text();
}

export function slugifyUrl(url: string): string {
  return url
    .replace(/^https?:\/\//u, "")
    .replace(/^file:\/\//u, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60) || "feed";
}

/**
 * Human-readable lines for one rolled-up feed entry. `title` /
 * `link` / `publishedAt` are third-party-controlled (the feed
 * author sets them) and printed straight to the terminal, so
 * they get the same ESC/C0/C1/DEL strip + whitespace-collapse
 * the inbox / search surfaces apply — a hostile feed must not be
 * able to hijack the terminal.
 */
export function formatFeedEntryLines(entry: {
  readonly feedId: string;
  readonly title: string;
  readonly link: string;
  readonly publishedAt: string;
}): readonly string[] {
  const clean = (value: string): string =>
    stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
  const lines = [`[${clean(entry.feedId)}] ${clean(entry.title)} — ${clean(entry.publishedAt) || "(no date)"}`];
  const link = clean(entry.link);
  if (link) lines.push(`  ${link}`);
  return lines;
}

async function refreshSingleFeed(record: FeedRecord, io: ProgramIO): Promise<FeedRecord> {
  try {
    const body = await loadFeedBody(record.url);
    const incoming = parseFeedBody(body);
    // Merge with the on-disk archive so entries that rolled off
    // the publisher's window survive locally (deduped, capped).
    const entries = mergeFeedEntries(record.entries, incoming);
    return { ...record, lastFetchedAt: new Date().toISOString(), entries };
  } catch (cause) {
    io.stderr(`  ${record.id}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return record;
  }
}

export function registerFeedsCommand(program: Command, io: ProgramIO): void {
  const feeds = program.command("feeds").description("RSS/Atom feed ingest for ambient world-state");

  feeds
    .command("add")
    .description("Register a new feed; fetches once on add")
    .argument("<url>", "RSS / Atom feed URL (http(s):// or file://)")
    .option("--id <alias>", "Stable id (default: slug of URL)")
    .option("--name <name>", "Human-readable name")
    .action(async (url: string, options: { readonly id?: string; readonly name?: string }) => {
      const trimmedUrl = url.trim();
      if (trimmedUrl.length === 0) {
        io.stderr("muse feeds add: feed URL must be non-empty (http(s):// or file://)\n");
        process.exitCode = 1;
        return;
      }
      const file = defaultFeedsFile();
      const store = await readFeedsStore(file);
      const trimmedExplicit = options.id?.trim() ?? "";
      const id = trimmedExplicit.length > 0 ? trimmedExplicit : slugifyUrl(trimmedUrl);
      if (store.feeds.some((f) => f.id === id)) {
        io.stderr(`muse feeds add: id '${id}' already exists. Pass --id <new-alias> or remove the existing entry.\n`);
        process.exitCode = 1;
        return;
      }
      let entries: readonly FeedEntry[];
      try {
        const body = await loadFeedBody(trimmedUrl);
        entries = parseFeedBody(body);
      } catch (cause) {
        io.stderr(`muse feeds add: initial fetch failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const next: FeedsStore = {
        version: store.version,
        feeds: [
          ...store.feeds,
          { id, url: trimmedUrl, name: options.name ?? id, lastFetchedAt: new Date().toISOString(), entries }
        ]
      };
      await writeFeedsStore(file, next);
      io.stdout(`Added feed ${id} (${entries.length.toString()} entry/entries) — ${url}\n`);
    });

  feeds
    .command("list")
    .description("List configured feeds + last-fetched timestamps")
    .option("--json", "Emit the raw store")
    .action(async (options: { readonly json?: boolean }) => {
      const store = await readFeedsStore(defaultFeedsFile());
      if (options.json) {
        const feeds = store.feeds.map((f) => ({
          id: f.id, url: f.url, name: f.name,
          lastFetchedAt: f.lastFetchedAt, entries: f.entries.length
        }));
        io.stdout(`${JSON.stringify({ feeds, total: feeds.length }, null, 2)}\n`);
        return;
      }
      if (store.feeds.length === 0) {
        io.stdout("(no feeds — `muse feeds add <url>` to register one)\n");
        return;
      }
      for (const feed of store.feeds) {
        io.stdout(`${feed.id}\t${feed.entries.length.toString()} entries\t${feed.url}\n`);
      }
    });

  feeds
    .command("remove")
    .description("Drop a feed by id")
    .argument("<id>", "Feed id (see `muse feeds list`)")
    .action(async (id: string) => {
      const file = defaultFeedsFile();
      const store = await readFeedsStore(file);
      const trimmed = id.trim();
      const exists = store.feeds.some((f) => f.id === trimmed);
      if (!exists) {
        const suggestion = closestCommandName(trimmed, store.feeds.map((f) => f.id));
        io.stderr(`muse feeds remove: no feed with id '${trimmed}'`);
        if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
        io.stderr(" (run `muse feeds list` to see ids)\n");
        process.exitCode = 1;
        return;
      }
      const next = { version: store.version, feeds: store.feeds.filter((f) => f.id !== trimmed) };
      await writeFeedsStore(file, next);
      io.stdout(`Removed feed '${trimmed}'\n`);
    });

  feeds
    .command("refresh")
    .description("Re-fetch all feeds (or one with --id)")
    .option("--id <id>", "Refresh just one feed")
    .action(async (options: { readonly id?: string }) => {
      const file = defaultFeedsFile();
      const store = await readFeedsStore(file);
      // A bad --id must error, not print "(no feeds to refresh)"
      // — that's indistinguishable from a successful no-op refresh.
      if (options.id !== undefined) {
        const trimmed = options.id.trim();
        const exists = store.feeds.some((f) => f.id === trimmed);
        if (!exists) {
          const suggestion = closestCommandName(trimmed, store.feeds.map((f) => f.id));
          io.stderr(`muse feeds refresh: no feed with id '${trimmed}'`);
          if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
          io.stderr(" (run `muse feeds list` to see ids)\n");
          process.exitCode = 1;
          return;
        }
      }
      const targetId = options.id?.trim();
      const targets = targetId && targetId.length > 0
        ? store.feeds.filter((f) => f.id === targetId)
        : store.feeds;
      if (targets.length === 0) {
        io.stdout("(no feeds to refresh)\n");
        return;
      }
      const refreshed: FeedRecord[] = [];
      for (const feed of store.feeds) {
        if (targets.includes(feed)) {
          refreshed.push(await refreshSingleFeed(feed, io));
        } else {
          refreshed.push(feed);
        }
      }
      await writeFeedsStore(file, { version: store.version, feeds: refreshed });
      io.stdout(`Refreshed ${targets.length.toString()} feed(s)\n`);
    });

  feeds
    .command("today")
    .description("Show entries published within the lookback window")
    .option("--hours <n>", "Lookback hours (default 24)")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly hours?: string; readonly json?: boolean }) => {
      // Reject non-numeric --hours rather than silently using 24
      // (a "4h" unit-slip must not look like a successful filter).
      let hours = 24;
      if (options.hours !== undefined) {
        const trimmed = options.hours.trim();
        if (trimmed.length === 0) {
          throw new Error("--hours must not be empty");
        }
        // Use Number() (strict) instead of Number.parseFloat
        // (forgiving prefix parse) so "4h" / "12hrs" reject instead
        // of silently becoming 4 / 12 — those are user-unit-confusion
        // typos, not the integer the flag wants.
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          throw new Error(`--hours must be a positive number (got '${options.hours}')`);
        }
        if (parsed <= 0) {
          throw new Error(`--hours must be > 0 (got ${parsed.toString()})`);
        }
        hours = parsed;
      }
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
      const store = await readFeedsStore(defaultFeedsFile());
      const rolled = store.feeds.flatMap((feed) =>
        filterRecentFeedEntries(feed.entries, cutoff).map((entry) => ({
          id: entry.id, feedId: feed.id, feedName: feed.name,
          title: entry.title, link: entry.link,
          publishedAt: entry.publishedAt, summary: entry.summary
        }))
      ).sort(compareFeedEntriesNewestFirst);
      if (options.json) {
        io.stdout(`${JSON.stringify({ entries: rolled, hours, total: rolled.length }, null, 2)}\n`);
        return;
      }
      if (rolled.length === 0) {
        io.stdout(`(no feed entries in the last ${hours.toString()}h — try a longer --hours window or run \`muse feeds refresh\`)\n`);
        return;
      }
      for (const entry of rolled) {
        for (const line of formatFeedEntryLines(entry)) io.stdout(`${line}\n`);
      }
    });
}
