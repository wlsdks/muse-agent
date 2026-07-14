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

import { isRecord, stripUntrustedTerminalChars } from "@muse/shared";
import { XMLParser } from "fast-xml-parser";

import { roundVectorForStore } from "./browsing-store.js";
import { backupVersionMismatchedStore } from "./store-version-backup.js";

export const FEEDS_STORE_SCHEMA_VERSION = 1;

export interface FeedEntry {
  readonly id: string;
  readonly title: string;
  readonly link: string;
  readonly publishedAt: string;
  readonly summary: string;
  /**
   * OPTIONAL title embedding (nomic-embed-text-v2-moe, 768-dim), computed at
   * refresh/add time so a KO query can reach an EN headline the same way browsing
   * does. Additive + backward-compatible: the schema stays v1, a pre-embed entry
   * simply lacks it and stays lexically matchable. TITLE ONLY (parity with the
   * browsing choice — summaries are long/HTML-ish and would dilute the vector).
   */
  readonly embedding?: readonly number[];
}

/**
 * nomic-embed-text-v2-moe is task-prefixed: the STORED headline is the
 * `search_document:` side and the query the `search_query:` side. Identical
 * convention to `browsingDocEmbedText`/`browsingQueryEmbedText` (same model, same
 * cross-lingual floor), so the query embed is SHARED with browsing (one call).
 */
export function feedDocEmbedText(entry: Pick<FeedEntry, "title">): string {
  return `search_document: ${entry.title}`;
}

export function feedQueryEmbedText(query: string): string {
  return `search_query: ${query}`;
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
    entries: Array.isArray(raw.entries) ? raw.entries.map(normalizeFeedEntry) : []
  };
}

/**
 * Tolerate BOTH entry shapes on read: an entry with a valid embedding keeps it; a
 * pre-embed entry (no `embedding` key) passes through verbatim; a MALFORMED
 * embedding (non-array / empty / non-finite) is stripped WITHOUT dropping the
 * entry — it just falls back to lexical/recency matching. Mirrors the browsing
 * store's tolerant read.
 */
function normalizeFeedEntry(entry: FeedEntry): FeedEntry {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as FeedEntry & { embedding?: unknown };
  if (!("embedding" in e)) return entry;
  const valid =
    Array.isArray(e.embedding) &&
    e.embedding.length > 0 &&
    e.embedding.every((n) => typeof n === "number" && Number.isFinite(n));
  if (valid) return entry;
  const { embedding: _drop, ...rest } = e;
  return rest as FeedEntry;
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
    const parsed = parser.parse(body);
    if (!isRecord(parsed)) {
      return [];
    }
    doc = parsed;
  } catch {
    return [];
  }
  // RSS 2.0
  const rss = isRecord(doc.rss) ? doc.rss : undefined;
  if (isRecord(rss) && isRecord(rss.channel)) {
    const items = toArray(rss.channel.item);
    return items.flatMap((item) => toRssEntry(item));
  }
  // Atom
  const atom = isRecord(doc.feed) ? doc.feed : undefined;
  if (isRecord(atom) && atom.entry !== undefined) {
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
  if (!isRecord(item)) return [];
  const raw = item;
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
  if (!isRecord(entry)) return [];
  const raw = entry;
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
  const candidates = (Array.isArray(linkRaw) ? linkRaw : [linkRaw]).filter((l): l is Record<string, unknown> =>
    isRecord(l)
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
  if (isRecord(value) && "#text" in value) {
    const inner = value["#text"];
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
 * Dedup key is `entry.id` — incoming wins on the CONTENT fields
 * (publishers occasionally republish with an updated title / summary).
 * Sort is newest-first by `publishedAt` (parseable ISO); entries with
 * missing / unparseable dates sort to the tail in input order. Final
 * list is sliced to `cap` (default {@link DEFAULT_FEED_ENTRIES_CAP}).
 *
 * EMBEDDING CARRY-FORWARD (why feeds differ from browsing): every refresh
 * re-fetches the SAME ids with a freshly-parsed entry that has NO embedding,
 * so a blind "incoming wins" would wipe the stored embedding on EVERY refresh.
 * So when incoming and stored share an id and incoming lacks an embedding, the
 * stored embedding is carried forward — but ONLY if the title is unchanged (the
 * embedding is OF the title). A changed title makes the old embedding stale, so
 * it is dropped and the next backfill re-embeds the new title.
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
    if (!entry.id) continue;
    const stored = byId.get(entry.id);
    if (stored?.embedding && !entry.embedding && stored.title === entry.title) {
      byId.set(entry.id, { ...entry, embedding: stored.embedding });
    } else {
      byId.set(entry.id, entry);  // incoming wins on republish (stale/absent embedding dropped)
    }
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

/**
 * Per-run cap on RE-embedding already-stored, not-yet-embedded entries. Fresh
 * `incomingIds` are ALWAYS embedded; this bounds only the backfill so a pre-embed
 * archive converges over several refreshes instead of one giant stall. Mirrors
 * BROWSING_BACKFILL_CAP.
 */
export const FEED_BACKFILL_CAP = 200;

/**
 * Embed the titles of `entries` that lack an embedding. Fresh `incomingIds` are
 * ALWAYS embedded; older entries consume a bounded `backfillCap` budget. Per-entry
 * fail-soft: an embed error keeps the entry WITHOUT an embedding (a refresh never
 * fails because Ollama is down). Pure mechanism — the embedder is injected. Mirrors
 * `embedBrowsingVisits`.
 */
export async function embedFeedEntries(
  entries: readonly FeedEntry[],
  embed: (text: string) => Promise<readonly number[]>,
  opts: { readonly incomingIds: ReadonlySet<string>; readonly backfillCap?: number }
): Promise<readonly FeedEntry[]> {
  const backfillCap = opts.backfillCap ?? FEED_BACKFILL_CAP;
  let backfillUsed = 0;
  const out: FeedEntry[] = [];
  for (const entry of entries) {
    if (entry.embedding && entry.embedding.length > 0) {
      out.push(entry);
      continue;
    }
    const isNew = opts.incomingIds.has(entry.id);
    if (!isNew && backfillUsed >= backfillCap) {
      out.push(entry);
      continue;
    }
    try {
      const vec = await embed(feedDocEmbedText(entry));
      out.push({ ...entry, embedding: roundVectorForStore(vec) });
      if (!isNew) backfillUsed += 1;
    } catch {
      out.push(entry); // fail-soft: store without an embedding, never abort the refresh
    }
  }
  return out;
}
