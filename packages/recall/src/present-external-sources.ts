/**
 * External-source selection for presentation: watched-feed headlines and
 * browsing visits. Both are time-ordered world state rather than the
 * embedded note corpus, so they carry their own cosine floors and are
 * selected here instead of going through the note ranking path.
 */

import { cosineSimilarity, lexicalOverlap, lexicalTokens } from "@muse/agent-core";

import type { BrowsingVisit } from "./browsing-store.js";

/**
 * The most-recent watched-feed headlines across ALL feeds, newest
 * first, capped at `limit`. Feeds are time-ordered world-state (not embedded),
 * so we surface recent items directly — the second brain reaches your
 * subscribed knowledge ("what's new in X?"). Pure; unparseable dates sort last.
 */
export function recentFeedHeadlines(
  feeds: ReadonlyArray<{ readonly name: string; readonly entries: ReadonlyArray<{ readonly title: string; readonly publishedAt: string; readonly summary: string }> }>,
  limit: number
): Array<{ feedName: string; title: string; publishedAt: string; summary: string }> {
  if (limit <= 0) {
    return [];
  }
  return feeds
    .flatMap((feed) => feed.entries.map((e) => ({ feedName: feed.name, publishedAt: e.publishedAt, summary: e.summary, title: e.title })))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, limit);
}

interface FeedHeadline {
  feedName: string;
  title: string;
  publishedAt: string;
  summary: string;
}

/** Feeds embed titles only, same model + prefixes as browsing, so the SAME cross-lingual floor (0.18) separates real KO↔EN matches from noise. */
const FEED_COSINE_FLOOR = 0.18;

function feedHeadlineKey(h: { feedName: string; title: string; publishedAt: string }): string {
  return `${h.feedName}\u0000${h.title}\u0000${h.publishedAt}`;
}

/**
 * Feed headlines for the ask grounding block: the recency window (today's base
 * behaviour, always first) UNION a query-relevant rescue arm that surfaces
 * OLDER-than-window entries matching the query.
 *
 * The rescue arm fires ONLY when `queryEmbedding` is supplied (i.e. the archive
 * holds embedded entries) — so with no embeddings this is BYTE-IDENTICAL to
 * `recentFeedHeadlines` (regression-pinned). When it fires: lexical overlap on
 * title+summary (Korean-safe via `lexicalTokens`) UNION a cross-lingual cosine
 * arm (a KO query → an EN headline the lexical arm can't reach). Lexical hits
 * rank above semantic-only; rescues are deduped against the recency base and
 * capped at `queryLimit`. Pure (no IO, no Date.now).
 */
export function selectFeedHeadlinesForQuery(
  feeds: ReadonlyArray<{ readonly name: string; readonly entries: ReadonlyArray<{ readonly title: string; readonly publishedAt: string; readonly summary: string; readonly embedding?: readonly number[] }> }>,
  query: string,
  recencyLimit: number,
  queryEmbedding?: readonly number[],
  queryLimit = 6
): FeedHeadline[] {
  const base = recentFeedHeadlines(feeds, recencyLimit);
  if (!queryEmbedding || queryLimit <= 0) {
    return base;
  }
  const queryTokens = lexicalTokens(query);
  const scored = feeds
    .flatMap((feed) => feed.entries.map((e) => ({ e, feed })))
    .map(({ e, feed }) => {
      const overlap = queryTokens.size > 0 ? lexicalOverlap(queryTokens, `${e.title} ${e.summary}`) : 0;
      const cosine = e.embedding && e.embedding.length > 0 ? cosineSimilarity(queryEmbedding, e.embedding) : 0;
      return { cosine, e, feed, overlap };
    })
    .filter((s) => s.overlap > 0 || s.cosine >= FEED_COSINE_FLOOR);
  scored.sort((a, b) => {
    const aLex = a.overlap > 0 ? 1 : 0;
    const bLex = b.overlap > 0 ? 1 : 0;
    if (aLex !== bLex) {
      return bLex - aLex;
    }
    const recency = (Date.parse(b.e.publishedAt) || 0) - (Date.parse(a.e.publishedAt) || 0);
    return aLex === 1 ? b.overlap - a.overlap || recency : b.cosine - a.cosine || recency;
  });
  const seen = new Set(base.map(feedHeadlineKey));
  const rescues: FeedHeadline[] = [];
  for (const s of scored) {
    const h: FeedHeadline = { feedName: s.feed.name, publishedAt: s.e.publishedAt, summary: s.e.summary, title: s.e.title };
    const key = feedHeadlineKey(h);
    if (seen.has(key)) continue;
    seen.add(key);
    rescues.push(h);
    if (rescues.length >= queryLimit) break;
  }
  return [...base, ...rescues];
}

/**
 * The registrable hostname a browsing visit is grounded/cited by —
 * `https://news.ycombinator.com/item?id=1` → `news.ycombinator.com`, leading
 * `www.` dropped so the same site cites stably. An unparseable URL falls back to
 * its trimmed-lowercased self (never throws). The citation IDENTIFIER (like a feed
 * name), matched EXACTLY by the gate. Pure.
 */
export function browsingHostname(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** A browsing-history visit selected for grounding: its citation host + the visit fields. */
export interface BrowsingHit {
  readonly host: string;
  readonly title: string;
  readonly url: string;
  readonly visitedAt: string;
}

/**
 * Cosine floor above which a browsing visit counts as a cross-lingual match to
 * the (prefixed) query embedding. Reuses the memory/action cross-lingual floor
 * exactly — same model (nomic-embed-text-v2-moe), same `search_query:`/
 * `search_document:` prefixes — validated live for THIS surface: a KO query vs
 * related EN titles scored 0.21 / 0.35, unrelated ≤0.12, so 0.18 separates the
 * real matches from noise (margin ~0.09). Below it a visit is a genuine miss, not
 * a language artifact.
 */
const BROWSING_COSINE_FLOOR = 0.18;

/**
 * The browsing visits most RELEVANT to `query`, for the ask grounding block. Two
 * arms, UNIONED then capped at `limit`:
 *
 * - LEXICAL: visits whose title/URL share a content token with the query. Query
 *   tokens come from `lexicalTokens` (NFC + CJK-aware), so a Korean query
 *   ("러스트 블로그") matches a Korean title, not only ASCII.
 * - SEMANTIC (only when `queryEmbedding` is supplied): a visit whose stored title
 *   embedding is ≥ the cosine floor — this is what lets a KO query reach an
 *   EN-titled page the lexical arm can't (the archive is mostly English).
 *
 * Lexical hits ALWAYS outrank semantic-only hits (an exact keyword match is never
 * displaced by a weak cosine hit); within each arm, stronger score wins, newest
 * breaks ties. A visit matched by BOTH arms is a single entry scored in the
 * lexical tier (no double-listing). NO `queryEmbedding` ⇒ byte-identical to the
 * prior lexical-only behaviour (regression-pinned). Pure (no IO, no Date.now).
 */
export function selectBrowsingVisitsForQuery(
  visits: readonly BrowsingVisit[],
  query: string,
  limit: number,
  queryEmbedding?: readonly number[]
): BrowsingHit[] {
  if (limit <= 0) {
    return [];
  }
  const queryTokens = lexicalTokens(query);
  const scored = visits
    .map((v) => {
      const overlap = queryTokens.size > 0 ? lexicalOverlap(queryTokens, `${v.title} ${v.url}`) : 0;
      const cosine =
        queryEmbedding && v.embedding && v.embedding.length > 0
          ? cosineSimilarity(queryEmbedding, v.embedding)
          : 0;
      return { cosine, overlap, v };
    })
    .filter((e) => e.overlap > 0 || e.cosine >= BROWSING_COSINE_FLOOR);
  scored.sort((a, b) => {
    const aLex = a.overlap > 0 ? 1 : 0;
    const bLex = b.overlap > 0 ? 1 : 0;
    if (aLex !== bLex) {
      return bLex - aLex;
    }
    const recency = (Date.parse(b.v.visitedAt) || 0) - (Date.parse(a.v.visitedAt) || 0);
    return aLex === 1 ? b.overlap - a.overlap || recency : b.cosine - a.cosine || recency;
  });
  return scored
    .slice(0, limit)
    .map((e) => ({ host: browsingHostname(e.v.url), title: e.v.title, url: e.v.url, visitedAt: e.v.visitedAt }));
}

/**
 * "Shows its work" made FOLLOWABLE: the openable-path footer for the notes a
 * `muse ask` answer actually CITED. Takes the post-gate answer (so only real
 * surviving `[from …]` citations count), dedups, and resolves each to a full
 * path the user can open to verify the receipt. Returns undefined when nothing
 * was cited (no footer). Pure → directly testable.
 */
