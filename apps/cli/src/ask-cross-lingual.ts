import type { ActionLogEntry } from "@muse/mcp";
import { allUserMemoryFacts, selectGroundingActions, selectMemoryFacts, type MemoryFact } from "@muse/recall";

export type EmbedFn = (text: string) => Promise<readonly number[]>;

/**
 * Speed guard: the cross-lingual fallback embeds the query + EVERY candidate
 * entry, so on a very large store it would add many embed round-trips to a
 * single ask. Above this count we skip the fallback (lexical-only stands) —
 * the rescue is for a personal-scale store, not a bulk index.
 */
const MAX_CROSS_LINGUAL_ENTRIES = 50;

// nomic-embed-text-v2-moe is a task-prefixed model: WITHOUT these prefixes a
// KO query and a semantically-equal EN entry score ~0.29 while an unrelated
// pair scores ~0.31 (no separating floor exists); WITH them, matches land
// 0.21–0.37 and non-matches 0.14–0.16 — measured live. The rescue embeds
// fresh here (it never reuses the notes index), so prefixing this path only is
// safe and needs no index rebuild.
const asQuery = (text: string): string => `search_query: ${text}`;
const asDoc = (text: string): string => `search_document: ${text}`;

interface MemoryStore {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
}

/**
 * Cross-lingual rescue for user-memory facts. Called ONLY when lexical
 * selection returned nothing (a KO query against EN facts scores lexical-0),
 * so the common same-language path pays ZERO embedding cost. Embeds the query
 * + each fact and lets the cosine arm in `selectMemoryFacts` surface a
 * semantically-matching fact above the conservative floor.
 */
export async function rescueMemoryCrossLingual(
  memory: MemoryStore,
  queryText: string,
  queryTokens: ReadonlySet<string>,
  embedFn: EmbedFn,
  max = 5
): Promise<readonly MemoryFact[]> {
  const facts = allUserMemoryFacts(memory);
  if (facts.length === 0 || facts.length > MAX_CROSS_LINGUAL_ENTRIES) {
    return [];
  }
  const queryVec = await embedFn(asQuery(queryText));
  const entryVecs = await Promise.all(facts.map((f) => embedFn(asDoc(`${f.key} ${f.value}`))));
  return selectMemoryFacts(memory, queryTokens, max, { entryVecs, queryVec });
}

/**
 * Cross-lingual rescue for action-log entries. Same contract as
 * {@link rescueMemoryCrossLingual}: lexical-empty trigger, speed-guarded,
 * cosine-floored.
 */
export async function rescueActionsCrossLingual(
  entries: readonly ActionLogEntry[],
  queryText: string,
  embedFn: EmbedFn,
  max = 5
): Promise<readonly ActionLogEntry[]> {
  if (entries.length === 0 || entries.length > MAX_CROSS_LINGUAL_ENTRIES) {
    return [];
  }
  const queryVec = await embedFn(asQuery(queryText));
  const entryVecs = await Promise.all(entries.map((e) => embedFn(asDoc(e.what))));
  return selectGroundingActions(entries, queryText, max, { entryVecs, queryVec });
}
