/**
 * The "second brain" grounding blocks for `muse ask`, lifted out of the
 * commands-ask god-file: past-session episodes (with an auto-refresh of the
 * episode index + untrusted-source tagging), recent watched-feed headlines, and
 * the user's own grounded reflections. Each store read is optional + fail-soft —
 * a missing/unreadable store never breaks the answer, it just contributes no
 * block. Returns the blocks + the hit lists the caller threads into the prompt,
 * the trust signals, and the run-log.
 */

import { buildBrowsingContextBlock, buildEpisodeContextBlock, buildFeedContextBlock } from "./context-blocks.js";
import { selectBrowsingVisitsForQuery, selectFeedHeadlinesForQuery, type BrowsingHit } from "./present.js";
import { rankEpisodeHits } from "./select.js";
import { readEpisodes, readReflections, selectReflectionsForRecall } from "@muse/stores";

import { filterLiveEpisodeEntries } from "./live-files.js";
import { buildEpisodeIndex, defaultEpisodeIndexFile, episodeIndexStale, loadEpisodeIndex, saveEpisodeIndex } from "./episode-index.js";
import { defaultFeedsFile, readFeedsStore, type FeedRecord } from "./feeds-store.js";
import { browsingQueryEmbedText, readBrowsingStore, type BrowsingVisit } from "./browsing-store.js";

export interface SessionFeedReflectionGrounding {
  readonly episodeHits: Array<{ id: string; summary: string; score: number }>;
  readonly untrustedEpisodeIds: Set<string>;
  readonly episodeBlock: string;
  readonly feedHeadlines: Array<{ feedName: string; title: string; publishedAt: string; summary: string }>;
  readonly feedBlock: string;
  readonly browsingHits: BrowsingHit[];
  readonly browsingBlock: string;
  readonly reflectionLines: string[];
  readonly reflectionBlock: string;
}

/**
 * Build the episode / feed / reflection grounding blocks. `queryVec` undefined
 * (notes unavailable) skips the embedding-based episode ranking but still yields
 * empty blocks. `autoReindex` false skips the incremental episode re-embed.
 */
export async function buildSessionFeedReflectionGrounding(params: {
  readonly queryVec: number[] | undefined;
  /** Raw query text — browsing selection is LEXICAL (relevance over a large archive), not embedding-based. */
  readonly queryText: string;
  readonly embedModel: string;
  readonly topK: number;
  readonly autoReindex: boolean;
  readonly onStderr: (text: string) => void;
  /** Resolved episodes-store path (autoconfigure owns resolution above this package). */
  readonly episodesFile: string;
  /** Resolved reflections-store path. */
  readonly reflectionsFile: string;
  /** Resolved browsing-history store path. */
  readonly browsingFile: string;
  /** Embed via the caller's resolved endpoint (the CLI binds the models.json merge). */
  readonly embedFn: (text: string, model: string) => Promise<number[]>;
}): Promise<SessionFeedReflectionGrounding> {
  const { queryVec, queryText, embedModel, topK, autoReindex, onStderr, episodesFile, reflectionsFile, browsingFile, embedFn } = params;

  // Auto-refresh the episode index (mirrors the notes auto-reindex) so past
  // sessions stay groundable without a manual `muse episode reindex` —
  // incremental, gated by --no-auto-reindex, fail-soft.
  if (autoReindex && queryVec) {
    try {
      const sourceEpisodes = await readEpisodes(episodesFile);
      const prevIndex = await loadEpisodeIndex(defaultEpisodeIndexFile());
      if (episodeIndexStale(prevIndex, sourceEpisodes, embedModel)) {
        const built = await buildEpisodeIndex({
          embedFn: (text) => embedFn(text, embedModel),
          episodes: sourceEpisodes,
          model: embedModel,
          nowIso: new Date().toISOString(),
          previous: prevIndex
        });
        await saveEpisodeIndex(defaultEpisodeIndexFile(), built.index);
        if (built.embedded > 0) {
          onStderr(`(auto-refreshed episode index: ${built.embedded.toString()} embedded, ${built.skipped.toString()} cached)\n`);
        }
      }
    } catch {
      // episode-index refresh failed — grounding still works on whatever index exists
    }
  }

  // SB-1 (second brain): ground on past-session episode summaries. Same embed
  // model only (a cross-model cosine is meaningless); optional + fail-soft.
  let episodeHits: Array<{ id: string; summary: string; score: number }> = [];
  // Episodes whose session rested on untrusted sources (trusted:false) — tagged so
  // an answer resting solely on a poisoned episode trips the untrusted-only source-
  // check cue instead of being laundered as trusted "your own history".
  let untrustedEpisodeIds = new Set<string>();
  if (queryVec) {
    try {
      const epIndex = await loadEpisodeIndex(defaultEpisodeIndexFile());
      if (epIndex && epIndex.model === embedModel && epIndex.entries.length > 0) {
        const sourceEpisodes = await readEpisodes(episodesFile);
        const liveIds = new Set(sourceEpisodes.map((e) => e.id));
        untrustedEpisodeIds = new Set(sourceEpisodes.filter((e) => e.trusted === false).map((e) => e.id));
        episodeHits = rankEpisodeHits(queryVec, filterLiveEpisodeEntries(epIndex.entries, liveIds), topK);
      }
    } catch {
      // episodes index missing / unreadable — grounding still works
    }
  }
  const episodeBlock = buildEpisodeContextBlock(episodeHits);

  // SB-1/G2 + Stage 4: watched-feed headlines AND the LOCAL Chrome browsing archive
  // both get a cross-lingual query-relevant arm. Read both stores up front so a
  // SINGLE `search_query:`-prefixed query embed serves BOTH (feeds' rescue arm and
  // browsing's cross-lingual arm use the SAME vector — never embed the query twice;
  // both prefix functions produce the identical string). The vec fires ONLY when at
  // least one archive holds embedded entries (the notes `queryVec` is the unprefixed
  // RAG space — unusable here), and falls back to each surface's lexical/recency base
  // when the embedder is down. Every read is optional + fail-soft.
  let feeds: readonly FeedRecord[] = [];
  try {
    feeds = (await readFeedsStore(defaultFeedsFile())).feeds;
  } catch {
    // feeds store missing / unreadable — grounding still works
  }
  let visits: readonly BrowsingVisit[] = [];
  try {
    visits = (await readBrowsingStore(browsingFile)).visits;
  } catch {
    // browsing store missing / unreadable — grounding still works
  }

  let crossLingualQueryVec: readonly number[] | undefined;
  const anyEmbedded =
    feeds.some((f) => f.entries.some((e) => e.embedding && e.embedding.length > 0)) ||
    visits.some((v) => v.embedding && v.embedding.length > 0);
  if (anyEmbedded) {
    try {
      crossLingualQueryVec = await embedFn(browsingQueryEmbedText(queryText), embedModel);
    } catch {
      // embedder down — both cross-lingual arms off, lexical/recency bases still run
    }
  }

  // Feeds: recency window (base, always present) UNION query-relevant rescues.
  let feedHeadlines: Array<{ feedName: string; title: string; publishedAt: string; summary: string }> = [];
  try {
    feedHeadlines = selectFeedHeadlinesForQuery(feeds, queryText, 8, crossLingualQueryVec);
  } catch {
    // selection failed — grounding still works
  }
  const feedBlock = buildFeedContextBlock(feedHeadlines);

  // Browsing: "that rust blog I read last week" — lexical (Korean-safe) UNION the
  // cross-lingual cosine arm so a KO query reaches an EN-titled page.
  let browsingHits: BrowsingHit[] = [];
  try {
    browsingHits = selectBrowsingVisitsForQuery(visits, queryText, 6, crossLingualQueryVec);
  } catch {
    // selection failed — grounding still works
  }
  const browsingBlock = buildBrowsingContextBlock(browsingHits);

  // Dreaming closes the loop: the user's own grounded reflections inform the
  // answer. Insight text only (already grounded); no-op when none. Fail-soft.
  let reflectionLines: string[] = [];
  try {
    reflectionLines = selectReflectionsForRecall(await readReflections(reflectionsFile), Date.now()).slice(0, 5).map((r) => `- ${r.insight}`);
  } catch { /* no reflections — grounding still works */ }
  const reflectionBlock = reflectionLines.length === 0 ? "(none yet)" : reflectionLines.join("\n");

  return { browsingBlock, browsingHits, episodeBlock, episodeHits, feedBlock, feedHeadlines, reflectionBlock, reflectionLines, untrustedEpisodeIds };
}
