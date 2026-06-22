import { readEpisodes } from "@muse/stores";

import type { EpisodeSummaryLike } from "./knowledge-corpus.js";

/**
 * Read the user's past cross-session summaries out of the episodes store
 * (`~/.muse/episodes.json`, written by the episodic summariser) and flatten
 * them into the shape the knowledge corpus wants — newest first, scoped to
 * the given user — so "what did we discuss about X before?" becomes
 * answerable via `knowledge_search` (SB-1 unified recall).
 *
 * Fail-open: a missing / unreadable store yields `[]` (a partial corpus
 * still grounds an answer) — never throws into the search path.
 */
export async function readEpisodeKnowledgeEntries(
  file: string,
  userId: string,
  limit: number
): Promise<EpisodeSummaryLike[]> {
  let episodes: readonly { id: string; userId: string; endedAt?: string; summary: string }[];
  try {
    episodes = await readEpisodes(file);
  } catch {
    return [];
  }
  return episodes
    .filter((episode) => episode.userId === userId)
    .sort((a, b) => episodeTime(b) - episodeTime(a))
    .slice(0, Math.max(1, Math.trunc(limit)))
    .map((episode) => ({
      id: episode.id,
      summary: episode.summary,
      ...(episode.endedAt ? { when: episode.endedAt.slice(0, 10) } : {})
    }));
}

/** Epoch ms of an episode's `endedAt`, or `-Infinity` when missing / unparseable (sorts last). */
function episodeTime(episode: { endedAt?: string }): number {
  const t = episode.endedAt ? Date.parse(episode.endedAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}
