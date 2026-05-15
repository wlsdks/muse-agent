/**
 * Goal 092 — pure data layer for `~/.muse/feeds.json`. Shape:
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

import { XMLParser } from "fast-xml-parser";

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
    return { version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] };
  }
  const feeds = (candidate.feeds ?? []).filter((f) => f && typeof f === "object" && typeof f.id === "string" && typeof f.url === "string");
  return { version: FEEDS_STORE_SCHEMA_VERSION, feeds };
}

export async function writeFeedsStore(file: string, store: FeedsStore): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Goal 092 — parse an RSS 2.0 OR Atom feed body into a uniform
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
    trimValues: true
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
  const title = readScalar(raw.title);
  const link = readScalar(raw.link);
  const guid = readScalar(raw.guid) ?? link ?? title;
  if (!title || !guid) return [];
  return [{
    id: guid,
    title,
    link: link ?? "",
    publishedAt: readScalar(raw.pubDate) ?? "",
    summary: readScalar(raw.description) ?? ""
  }];
}

function toAtomEntry(entry: unknown): readonly FeedEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const raw = entry as Record<string, unknown>;
  const title = readScalar(raw.title);
  let link = "";
  const linkRaw = raw.link;
  if (typeof linkRaw === "string") {
    link = linkRaw;
  } else if (Array.isArray(linkRaw) && linkRaw.length > 0) {
    const first = linkRaw[0];
    link = (typeof first === "object" && first ? (first as Record<string, unknown>)["@_href"] as string : "") ?? "";
  } else if (linkRaw && typeof linkRaw === "object") {
    link = (linkRaw as Record<string, unknown>)["@_href"] as string ?? "";
  }
  const id = readScalar(raw.id) ?? link ?? title;
  if (!title || !id) return [];
  return [{
    id,
    title,
    link,
    publishedAt: readScalar(raw.updated) ?? readScalar(raw.published) ?? "",
    summary: readScalar(raw.summary) ?? readScalar(raw.content) ?? ""
  }];
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
 * Goal 115 — default cap on entries retained per feed. Large
 * feeds (NYT homepage, github-events firehose) can publish 100+
 * items per fetch; keeping every historical entry would bloat
 * `~/.muse/feeds.json` without serving ambient-awareness needs.
 * 200 entries × ~1KB each ≈ 200KB per feed — generous tail for
 * "what did this feed publish last week" while bounding worst-case
 * disk + parse cost.
 */
export const DEFAULT_FEED_ENTRIES_CAP = 200;

/**
 * Goal 115 — merge `incoming` (latest fetch) into `previous` (the
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
  const merged = [...byId.values()].sort((a, b) => {
    const ta = Date.parse(a.publishedAt);
    const tb = Date.parse(b.publishedAt);
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return tb - ta;
  });
  const effectiveCap = Number.isFinite(cap) && cap > 0
    ? Math.trunc(cap)
    : DEFAULT_FEED_ENTRIES_CAP;
  return merged.slice(0, effectiveCap);
}

/**
 * Goal 092 — pure filter: drop entries whose `publishedAt` is
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
  }).sort((a, b) => {
    const ta = Date.parse(a.publishedAt);
    const tb = Date.parse(b.publishedAt);
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return tb - ta;
  });
}
