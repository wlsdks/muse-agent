/**
 * Pick and render recent FEED headlines for the morning brief — the ambient
 * world-state the user subscribed to (`muse feeds`), surfaced unprompted instead
 * of only on `muse feeds today`. Titles were sanitised at ingest, and they are
 * shown VERBATIM (never fed through the model) so untrusted feed text can't steer
 * the brief.
 */

import { compareFeedEntriesNewestFirst, filterRecentFeedEntries, type FeedsStore } from "./feeds-store.js";

export interface BriefHeadline {
  readonly title: string;
  readonly feedTitle: string;
  readonly link: string;
}

export interface BriefFeedOptions {
  readonly withinHours?: number;
  readonly limit?: number;
}

/**
 * The most recent feed headlines across ALL feeds — published within
 * `withinHours`, newest first, capped at `limit`, empty-title entries dropped.
 */
export function selectBriefFeedHeadlines(store: FeedsStore, nowMs: number, options: BriefFeedOptions = {}): readonly BriefHeadline[] {
  const withinHours = Math.max(1, options.withinHours ?? 24);
  const limit = Math.max(1, options.limit ?? 3);
  const cutoff = new Date(nowMs - withinHours * 3_600_000);
  return store.feeds
    .flatMap((feed) => filterRecentFeedEntries(feed.entries, cutoff).map((entry) => ({ entry, feedTitle: feed.name })))
    .filter(({ entry }) => entry.title.trim().length > 0)
    .sort((a, b) => compareFeedEntriesNewestFirst(a.entry, b.entry))
    .slice(0, limit)
    .map(({ entry, feedTitle }) => ({ feedTitle, link: entry.link, title: entry.title }));
}

/** Render the "📰 In your feeds" block — empty string when there is nothing recent. */
export function formatBriefFeedLines(headlines: readonly BriefHeadline[]): string {
  if (headlines.length === 0) return "";
  const lines = headlines.map((headline) => `  · ${headline.title}${headline.feedTitle ? ` (${headline.feedTitle})` : ""}`);
  return `\n📰 In your feeds:\n${lines.join("\n")}\n`;
}
