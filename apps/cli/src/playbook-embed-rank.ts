import { rankPlaybookStrategiesByRelevance, type PlaybookStrategy } from "@muse/agent-core";

/**
 * Minimal shape of a stored playbook entry the CLI hands to the ranker.
 * Mirrors the fields the embed-rank path projects; kept structural so the
 * CLI doesn't depend on the mcp store's concrete entry type.
 */
export interface PlaybookEntryLike {
  readonly text: string;
  readonly tag?: string;
  readonly reward?: number;
  readonly probation?: boolean;
  readonly reinforcements?: number;
  readonly decays?: number;
  readonly lastReinforcedAt?: string;
  readonly createdAt?: string;
}

export function toPlaybookStrategy(entry: PlaybookEntryLike): PlaybookStrategy {
  return {
    text: entry.text,
    ...(entry.tag ? { tag: entry.tag } : {}),
    ...(typeof entry.reward === "number" ? { reward: entry.reward } : {}),
    ...(entry.probation ? { probation: true } : {}),
    ...(typeof entry.reinforcements === "number" ? { reinforcements: entry.reinforcements } : {}),
    ...(typeof entry.decays === "number" ? { decays: entry.decays } : {}),
    ...(entry.lastReinforcedAt ? { lastReinforcedAt: entry.lastReinforcedAt } : {}),
    ...(entry.createdAt ? { createdAt: entry.createdAt } : {})
  };
}

/**
 * Embedding-ranked playbook retrieval for the opt-in `MUSE_PLAYBOOK_EMBED_RANK`
 * path. Maps stored entries to strategies (carrying the recency anchors) and
 * ranks them by semantic relevance. `nowMs` feeds the D-UCB temporal discount
 * (arXiv:0805.3415) so stale reinforcements fade — pass `Date.now()` on the
 * live path. Without this anchor the discount was inert here even though the
 * mapper already carried the timestamps.
 */
export async function rankPlaybookEntriesByRelevance(
  entries: readonly PlaybookEntryLike[],
  query: string,
  embed: (text: string) => Promise<readonly number[]>,
  topK: number | undefined,
  nowMs: number
): Promise<readonly PlaybookStrategy[]> {
  const mapped = entries.map(toPlaybookStrategy);
  return rankPlaybookStrategiesByRelevance(
    mapped,
    query,
    embed,
    topK === undefined ? undefined : { topK },
    nowMs
  );
}
