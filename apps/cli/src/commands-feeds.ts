/**
 * `muse feeds` — RSS / Atom ingest.
 *
 *   muse feeds add <url> [--id <alias>] [--name <name>]
 *   muse feeds list [--json]
 *   muse feeds remove <id>
 *   muse feeds refresh [--id <id>]
 *   muse feeds today [--hours <n>] [--json]
 *
 * `~/.muse/feeds.json` carries every feed's url + cached entries
 * so `today` doesn't need network. Pure XML parsing via
 * `fast-xml-parser` (MIT). Feed fetch is SSRF-guarded for http(s) (no
 * internal/metadata host, pre- and post-redirect); `file://` is supported
 * for offline fixtures / dogfood (a local, user-only read).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { assertPublicHttpUrl, isRetriableStatus } from "@muse/domain-tools";
import { formatErrorForTerminal, stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { defaultEmbedModel } from "./council-corpus.js";
import { embed } from "./embed.js";
import { collapseNearDuplicates } from "./feed-dedupe.js";
import { pluralize } from "./pluralize.js";
import {
  compareFeedEntriesNewestFirst,
  defaultFeedsFile,
  embedFeedEntries,
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
 * The localhost embedder for feed titles (`search_document:`-prefixed). Wired
 * into every ingest path (add + refresh) so a KO query can later reach an EN
 * headline; per-entry fail-soft (Ollama down ⇒ entries still ingest, unembedded).
 */
function feedTitleEmbedder(): (text: string) => Promise<readonly number[]> {
  return (text) => embed(text, defaultEmbedModel(process.env));
}

/**
 * Fetch the feed body. An http(s) URL is SSRF-guarded (pre- and post-redirect,
 * public hosts only, no internal/metadata target); a `file://` URL is read
 * directly — a local, user-only path for offline fixtures / dogfood, not
 * reachable from a model tool. Exported for direct test coverage.
 */
export const DEFAULT_FEED_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FEED_MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface LoadFeedBodyOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  /** Extra attempts after the first on a transient 429/5xx. Default 2. */
  readonly retries?: number;
  /** First backoff in ms; doubles each retry. Default 250. */
  readonly baseDelayMs?: number;
  /** Injectable delay so tests don't wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function loadFeedBody(url: string, options: LoadFeedBodyOptions = {}): Promise<string> {
  // `file://` reads a local fixture (offline / dogfood). It is a user-only CLI
  // path (never a model-reachable tool), so it carries no REMOTE attack surface;
  // the SSRF guard below is what closes the remote vector (a trusted feed that
  // redirects to an internal/metadata host).
  if (url.startsWith("file://")) {
    return readFile(fileURLToPath(url), "utf8");
  }
  // SSRF guard: an http(s) feed URL (or a redirect from a trusted feed) must
  // resolve to a PUBLIC host — blocks a direct or redirect-to internal/metadata
  // target (`169.254.169.254`, `127.0.0.1`, link-local). Re-checked after the
  // fetch for the final, post-redirect URL below.
  const preGuard = await assertPublicHttpUrl(url);
  if (!preGuard.ok) {
    throw new Error(`feed URL is not an allowed public http(s) address: ${url}`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? (options.timeoutMs as number)
    : DEFAULT_FEED_FETCH_TIMEOUT_MS;
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes) && (options.maxBodyBytes ?? 0) > 0
    ? (options.maxBodyBytes as number)
    : DEFAULT_FEED_MAX_BODY_BYTES;
  // Retry a transient 429/5xx (a feed server hiccup) with backoff,
  // bounded by the single wall-clock timeout below — the same posture
  // the weather/calendar/email read actuators use. An abort (timeout)
  // or network throw fails fast (no retry); the !ok throw catches a
  // 4xx or an exhausted 5xx.
  const retries = Number.isFinite(options.retries) ? Math.max(0, Math.trunc(options.retries as number)) : 2;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? Math.max(0, options.baseDelayMs as number) : 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new Error(`feed fetch ${url} timed out after ${timeoutMs.toString()}ms`, { cause });
        }
        throw cause;
      }
      if (response.ok || !isRetriableStatus(response.status) || attempt >= retries) {
        break;
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
    if (!response.ok) {
      throw new Error(`feed fetch ${url} returned ${response.status.toString()}`);
    }
    // Post-redirect re-guard: a trusted feed can 302 to an internal/metadata
    // host, which `redirect: "follow"` would have chased. If the FINAL URL is
    // not public, refuse the body before it is parsed/ingested.
    if (response.url && response.url !== url) {
      const postGuard = await assertPublicHttpUrl(response.url);
      if (!postGuard.ok) {
        throw new Error(`feed ${url} redirected to a non-public address: ${response.url}`);
      }
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const declaredBytes = Number.parseInt(declared, 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
        throw new Error(`feed body ${url} declared ${declaredBytes.toString()} bytes; cap is ${maxBodyBytes.toString()}`);
      }
    }
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let total = 0;
    let body = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel();
          throw new Error(`feed body ${url} exceeded ${maxBodyBytes.toString()} bytes`);
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      try { reader.releaseLock(); } catch { /* released by cancel or natural completion */ }
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
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

export interface FeedSearchHit {
  readonly id: string;
  readonly feedId: string;
  readonly feedName: string;
  readonly title: string;
  readonly link: string;
  readonly publishedAt: string;
  readonly summary: string;
}

/**
 * Case-insensitive substring search across every cached feed entry's
 * title + summary, newest-first, capped at `limit`. Pure (no IO) so a
 * unit test pins matching + ordering. `muse feeds today` only reaches a
 * recent time-window; this searches the whole on-disk archive (up to
 * DEFAULT_FEED_ENTRIES_CAP per feed) so "that article about X I saw last
 * week" is findable.
 */
export function searchFeedEntries(
  feeds: readonly FeedRecord[],
  query: string,
  limit: number
): readonly FeedSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const hits = feeds.flatMap((feed) =>
    feed.entries
      .filter((entry) => entry.title.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle))
      .map((entry) => ({
        feedId: feed.id,
        feedName: feed.name,
        id: entry.id,
        link: entry.link,
        publishedAt: entry.publishedAt,
        summary: entry.summary,
        title: entry.title
      }))
  );
  return [...hits].sort(compareFeedEntriesNewestFirst).slice(0, Math.max(1, limit));
}

/**
 * Strict `--limit` parse for `muse feeds search`: absent → fallback; a
 * non-numeric / unit-slip ('20x') / non-positive value rejects rather
 * than silently defaulting; a genuine number truncates + clamps to cap.
 */
export function parseFeedSearchLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.min(cap, Math.trunc(parsed));
}

async function refreshSingleFeed(
  record: FeedRecord,
  io: ProgramIO,
  embedFn?: (text: string) => Promise<readonly number[]>
): Promise<{ readonly record: FeedRecord; readonly ok: boolean }> {
  try {
    const body = await loadFeedBody(record.url);
    const incoming = parseFeedBody(body);
    // Merge with the on-disk archive so entries that rolled off
    // the publisher's window survive locally (deduped, capped). The
    // merge carries forward stored title embeddings across a same-title
    // republish, so a refresh never wipes them.
    const merged = mergeFeedEntries(record.entries, incoming);
    const entries = embedFn
      ? await embedFeedEntries(merged, embedFn, { incomingIds: new Set(incoming.map((e) => e.id)) })
      : merged;
    return { ok: true, record: { ...record, lastFetchedAt: new Date().toISOString(), entries } };
  } catch (cause) {
    io.stderr(`  ${record.id}: ${formatErrorForTerminal(cause)}\n`);
    return { ok: false, record };
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
      // Up-front scheme gate so `muse feeds add not-a-url` surfaces
      // the actual contract violation instead of the generic
      // `initial fetch failed: Invalid URL` from fetch()'s internals.
      if (!/^(?:https?:\/\/|file:\/\/)/iu.test(trimmedUrl)) {
        io.stderr(`muse feeds add: URL must start with http://, https://, or file:// (got '${trimmedUrl}')\n`);
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
        const parsed = parseFeedBody(body);
        // Embed titles on add so cross-lingual recall works immediately;
        // per-entry fail-soft (Ollama down ⇒ entries added unembedded, backfilled
        // on a later refresh).
        entries = await embedFeedEntries(parsed, feedTitleEmbedder(), { incomingIds: new Set(parsed.map((e) => e.id)) });
      } catch (cause) {
        io.stderr(`muse feeds add: initial fetch failed: ${formatErrorForTerminal(cause)}\n`);
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
        io.stdout(`${feed.id}\t${feed.entries.length.toString()} ${pluralize(feed.entries.length, "entry", "entries")}\t${feed.url}\n`);
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
      let succeeded = 0;
      const embedFn = feedTitleEmbedder();
      for (const feed of store.feeds) {
        if (targets.includes(feed)) {
          const result = await refreshSingleFeed(feed, io, embedFn);
          refreshed.push(result.record);
          if (result.ok) succeeded += 1;
        } else {
          refreshed.push(feed);
        }
      }
      await writeFeedsStore(file, { version: store.version, feeds: refreshed });
      // Report the count actually re-fetched, not the count attempted — a
      // fail-soft refresh where every feed is down (404 / timeout) must not
      // print "Refreshed N feed(s)" as if it succeeded while `today` stays
      // empty. A total failure also exits non-zero so a script notices.
      if (succeeded === targets.length) {
        io.stdout(`Refreshed ${targets.length.toString()} feed(s)\n`);
      } else {
        const failed = targets.length - succeeded;
        io.stdout(`Refreshed ${succeeded.toString()} of ${targets.length.toString()} feed(s) (${failed.toString()} failed — see errors above)\n`);
        if (succeeded === 0) {
          process.exitCode = 1;
        }
      }
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
        // --json is the raw archive view (structured consumers want every entry);
        // near-dup collapse applies only to the human render below.
        io.stdout(`${JSON.stringify({ entries: rolled, hours, total: rolled.length }, null, 2)}\n`);
        return;
      }
      if (rolled.length === 0) {
        io.stdout(`(no feed entries in the last ${hours.toString()}h — try a longer --hours window or run \`muse feeds refresh\`)\n`);
        return;
      }
      // Collapse the same story carried by several feeds (SimHash near-dup) so
      // the human view isn't three rows of one breaking headline — the freshest
      // of each cluster survives (rolled is newest-first). --json keeps them all.
      const { kept, collapsed } = collapseNearDuplicates(rolled, (entry) => entry.title);
      for (const entry of kept) {
        for (const line of formatFeedEntryLines(entry)) io.stdout(`${line}\n`);
      }
      if (collapsed > 0) {
        io.stdout(`\n(${collapsed.toString()} near-duplicate ${collapsed === 1 ? "story" : "stories"} collapsed — same story across feeds; \`--json\` for the full list)\n`);
      }
    });

  feeds
    .command("search")
    .description("Search the whole cached feed archive by keyword (title + summary), newest-first")
    .argument("<query...>", "Keyword(s) to match (joined by spaces; case-insensitive substring)")
    .option("--limit <n>", "Max matches (default 20, cap 100)")
    .option("--json", "Emit a structured payload")
    .action(async (queryParts: readonly string[], options: { readonly limit?: string; readonly json?: boolean }) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        io.stderr("muse feeds search: query is required\n");
        process.exitCode = 1;
        return;
      }
      const limit = parseFeedSearchLimit(options.limit, 20, 100);
      const store = await readFeedsStore(defaultFeedsFile());
      const hits = searchFeedEntries(store.feeds, query, limit);
      if (options.json) {
        io.stdout(`${JSON.stringify({ entries: hits, query, total: hits.length }, null, 2)}\n`);
        return;
      }
      if (hits.length === 0) {
        io.stdout(`(no cached feed entries match "${query}" — try a different keyword or run \`muse feeds refresh\`)\n`);
        return;
      }
      for (const hit of hits) {
        for (const line of formatFeedEntryLines(hit)) io.stdout(`${line}\n`);
      }
    });
}
