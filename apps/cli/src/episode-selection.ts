import type { PersistedEpisode } from "@muse/stores";

/**
 * Choose which episodes survive the persona cap (Generative Agents,
 * arXiv 2304.03442: importance is a retrieval axis, not just recency).
 *
 * Newest-first is the display order, but a pure-recency cap silently
 * drops a pivotal older session. So when there are more episodes than the
 * cap, we keep the top `cap` by a combined rank — recency position plus a
 * bounded importance bump — then return them newest-first for display.
 *
 * Conservative: an episode with no importance contributes 0 bump, so a
 * corpus where nothing carries a score is selected exactly by recency
 * (byte-identical to the pre-importance behaviour). Under the cap, every
 * episode is kept and only re-sorted newest-first.
 */
export function selectPersonaEpisodes(
  episodes: readonly PersistedEpisode[],
  cap: number,
  importanceWeight = 1
): readonly PersistedEpisode[] {
  const newestFirst = [...episodes].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  if (cap <= 0) {
    return [];
  }
  if (newestFirst.length <= cap) {
    return newestFirst;
  }
  // Score each episode by normalised recency + weighted normalised
  // importance, both in [0, 1] (Generative Agents combines normalised axes).
  // recencyNorm: newest = 1, oldest = 0. importanceNorm: imp/10, 0 when unset.
  // With the default equal weight, a maximally important old episode can
  // out-rank a recent low-importance one — rescuing a pivotal session — while
  // a corpus with no scores selects purely by recency.
  const lastIndex = newestFirst.length - 1;
  const scored = newestFirst.map((episode, index) => {
    const recencyNorm = (lastIndex - index) / lastIndex;
    const importance = typeof episode.importance === "number" && Number.isFinite(episode.importance)
      ? Math.min(10, Math.max(1, episode.importance))
      : 0;
    const importanceNorm = importance === 0 ? 0 : importance / 10;
    return { episode, index, score: recencyNorm + importanceWeight * importanceNorm };
  });
  const kept = scored
    .slice()
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, cap)
    .map((entry) => entry.episode);
  return kept.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}
