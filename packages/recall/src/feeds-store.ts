/**
 * Pure data layer for `~/.muse/feeds.json`. Shape:
 *
 *   { version: 1, feeds: [
 *     { id, url, name, lastFetchedAt?, entries: [
 *       { id, title, link, publishedAt, summary }
 *     ] }
 *   ] }
 *
 * Tolerant reads (missing / malformed → empty), atomic writes
 * via tmp + rename + 0o600, matching the rest of the personal
 * stores. Parser uses fast-xml-parser; supports both RSS 2.0
 * (`channel/item`) and Atom (`feed/entry`).
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { stripUntrustedTerminalChars } from "@muse/shared";
import { XMLParser } from "fast-xml-parser";

import { backupVersionMismatchedStore } from "./store-version-backup.js";

export const FEEDS_STORE_SCHEMA_VERSION = 1;

export interface FeedEntry {
  readonly id: string;
  readonly title: string;
  readonly link: string;
  readonly publishedAt: string;
  readonly summary: string;
}

export interface FeedRecord {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly lastFetchedAt?: string;
  readonly entries: readonly FeedEntry[];
}

export interface FeedsStore {
  readonly version: typeof FEEDS_STORE_SCHEMA_VERSION;
  readonly feeds: readonly FeedRecord[];
}

export function defaultFeedsFile(): string {
  const fromEnv = process.env.MUSE_FEEDS_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "feeds.json");
}

export async function readFeedsStore(file: string): Promise<FeedsStore> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] };
  }
  const candidate = parsed as Partial<FeedsStore>;
  if (candidate.version !== FEEDS_STORE_SCHEMA_VERSION) {
    await backupVersionMismatchedStore(file, candidate.version);
    return { version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] };
  }
  const feeds = (candidate.feeds ?? [])
    .filter((f) => f && typeof f === "object" && typeof f.id === "string" && typeof f.url === "string")
    .map((f) => normalizeFeedRecord(f));
  return { version: FEEDS_STORE_SCHEMA_VERSION, feeds };
}

function normalizeFeedRecord(raw: FeedRecord): FeedRecord {
  return {
    ...raw,
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id,
    entries: Array.isArray(raw.entries) ? raw.entries : []
  };
}

export async function writeFeedsStore(file: string, store: FeedsStore): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Parse an RSS 2.0 OR Atom feed body into a uniform
 * `FeedEntry[]`. Pure (string in, array out) so a unit test can
 * pin the format detection without touching fetch.
 *
 * The parser yields different shapes for the two formats:
 *   RSS 2.0 → `rss.channel.item[]` with `title / link / pubDate / description`
 *   Atom    → `feed.entry[]`         with `title / link[@href] / updated / summary`
 *
 * Each entry's `id` is the upstream `<guid>` / `<id>`, falling
 * back to the link (or a hash of the title when neither is
 * present).
 */
export function parseFeedBody(body: string): readonly FeedEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    // Real RSS/Atom titles routinely carry HTML entities
    // (`&rsquo;` `&mdash;` `&hellip;` `&#8217;`); without this they
    // reach `muse feeds` literally. sanitizeFeedText still strips
    // any control char a decoded numeric entity could introduce.
    htmlEntities: true
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  // RSS 2.0
  const rss = (doc as { rss?: { channel?: { item?: unknown } } }).rss;
  if (rss && rss.channel) {
    const items = toArray(rss.channel.item);
    return items.flatMap((item) => toRssEntry(item));
  }
  // Atom
  const atom = (doc as { feed?: { entry?: unknown } }).feed;
  if (atom) {
    const entries = toArray(atom.entry);
    return entries.flatMap((entry) => toAtomEntry(entry));
  }
  return [];
}

function toArray<T>(value: T | T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function toRssEntry(item: unknown): readonly FeedEntry[] {
  if (!item || typeof item !== "object") return [];
  const raw = item as Record<string, unknown>;
  const title = sanitizeFeedText(readScalar(raw.title));
  const link = sanitizeFeedText(readScalar(raw.link));
  const id = sanitizeFeedText(readScalar(raw.guid)) || link || title;
  if (!title || !id) return [];
  return [{
    id,
    title,
    link,
    publishedAt: sanitizeFeedText(readScalar(raw.pubDate)),
    summary: sanitizeFeedText(readScalar(raw.description))
  }];
}

function toAtomEntry(entry: unknown): readonly FeedEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const raw = entry as Record<string, unknown>;
  const title = sanitizeFeedText(readScalar(raw.title));
  const link = sanitizeFeedText(pickAtomLinkHref(raw.link));
  const id = sanitizeFeedText(readScalar(raw.id)) || link || title;
  if (!title || !id) return [];
  return [{
    id,
    title,
    link,
    publishedAt: sanitizeFeedText(readScalar(raw.updated) ?? readScalar(raw.published)),
    summary: sanitizeFeedText(readScalar(raw.summary) ?? readScalar(raw.content))
  }];
}

/**
 * RFC 4287 §4.2.7.2: an Atom entry may carry several `<link>`
 * elements (`alternate` = the human permalink, `self` / `edit` /
 * `enclosure` = feed/API/asset URLs). A missing `rel` MUST be read
 * as `alternate`. The old code took `link[0]` blindly, so a feed
 * that lists `rel="self"` first recorded the feed's own XML URL as
 * the article link. Pick the first `alternate` href; only if none
 * exists fall back to the first href (best effort — don't drop the
 * entry on a malformed feed).
 */
function pickAtomLinkHref(linkRaw: unknown): string {
  if (typeof linkRaw === "string") return linkRaw;
  const candidates = (Array.isArray(linkRaw) ? linkRaw : [linkRaw]).filter(
    (l): l is Record<string, unknown> => Boolean(l) && typeof l === "object"
  );
  let firstHref = "";
  for (const candidate of candidates) {
    const href = typeof candidate["@_href"] === "string" ? candidate["@_href"] : "";
    if (!href) continue;
    if (!firstHref) firstHref = href;
    const rel = typeof candidate["@_rel"] === "string" ? candidate["@_rel"] : "alternate";
    if (rel === "alternate") return href;
  }
  return firstHref;
}

function readScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    const inner = (value as { "#text"?: unknown })["#text"];
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

/**
 * Feed title / summary / link are wholly publisher-controlled and
 * land both on the terminal (`muse feeds today`) and in
 * `~/.muse/feeds.json`. Strip ESC / C0 / C1 / DEL bytes before they
 * reach a terminal, then collapse whitespace — the same boundary
 * treatment the inbox / search surfaces apply to untrusted text.
 */
function sanitizeFeedText(value: string | undefined): string {
  return stripUntrustedTerminalChars(value ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Default cap on entries retained per feed. Large
 * feeds (NYT homepage, github-events firehose) can publish 100+
 * items per fetch; keeping every historical entry would bloat
 * `~/.muse/feeds.json` without serving ambient-awareness needs.
 * 200 entries × ~1KB each ≈ 200KB per feed — generous tail for
 * "what did this feed publish last week" while bounding worst-case
 * disk + parse cost.
 */
export const DEFAULT_FEED_ENTRIES_CAP = 200;

/**
 * Merge `incoming` (latest fetch) into `previous` (the
 * on-disk archive). Old entries that have rolled off the feed's
 * server-side window survive locally — RSS / Atom servers typically
 * expose only the most recent N items, so without a merge the local
 * store would forget anything older than the publisher's window.
 *
 * Dedup key is `entry.id` — incoming wins (publishers occasionally
 * republish with updated title / summary). Sort is newest-first by
 * `publishedAt` (parseable ISO); entries with missing / unparseable
 * dates sort to the tail in input order. Final list is sliced to
 * `cap` (default {@link DEFAULT_FEED_ENTRIES_CAP}).
 *
 * Pure — no IO, no `Date.now()` — so the unit test pins every
 * branch.
 */
export function mergeFeedEntries(
  previous: readonly FeedEntry[],
  incoming: readonly FeedEntry[],
  cap: number = DEFAULT_FEED_ENTRIES_CAP
): readonly FeedEntry[] {
  const byId = new Map<string, FeedEntry>();
  for (const entry of previous) {
    if (entry.id) byId.set(entry.id, entry);
  }
  for (const entry of incoming) {
    if (entry.id) byId.set(entry.id, entry);  // incoming wins on republish
  }
  const merged = [...byId.values()].sort(compareFeedEntriesNewestFirst);
  const effectiveCap = Number.isFinite(cap) && cap > 0
    ? Math.trunc(cap)
    : DEFAULT_FEED_ENTRIES_CAP;
  return merged.slice(0, effectiveCap);
}

/**
 * Newest-first order with a *consistent* undated tail: two
 * undated entries compare equal (0), a single undated entry
 * sorts after a dated one. The earlier `muse feeds today`
 * inline comparator omitted the both-undated → 0 guard, making
 * `compare(a,b)===compare(b,a)===1` for two undated entries —
 * a non-antisymmetric comparator V8 may order arbitrarily.
 * Single-sourced here so the per-feed and merged sorts can't
 * drift again.
 */
export function compareFeedEntriesNewestFirst(
  a: { readonly publishedAt: string; readonly id: string },
  b: { readonly publishedAt: string; readonly id: string }
): number {
  const ta = Date.parse(a.publishedAt);
  const tb = Date.parse(b.publishedAt);
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return b.id.localeCompare(a.id);
  if (!Number.isFinite(ta)) return 1;
  if (!Number.isFinite(tb)) return -1;
  return tb - ta || b.id.localeCompare(a.id);
}

/**
 * Pure filter: drop entries whose `publishedAt` is
 * older than `cutoff`. Entries missing or with an unparseable
 * date are kept (no false-negative filtering on RSS feeds that
 * omit pubDate). Exported for direct unit-test coverage.
 */
export function filterRecentFeedEntries(
  entries: readonly FeedEntry[],
  cutoff: Date
): readonly FeedEntry[] {
  return entries.filter((entry) => {
    if (!entry.publishedAt) return true;
    const t = Date.parse(entry.publishedAt);
    if (!Number.isFinite(t)) return true;
    return t >= cutoff.getTime();
  }).sort(compareFeedEntriesNewestFirst);
}
