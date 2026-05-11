/**
 * Episodic recall surface (Context Engineering Phase 3).
 *
 * Provider returns the top-K most-relevant prior conversation
 * summaries given the current user prompt and injects them as
 * `[Episodic Memory]`. Implementation here is token-overlap-based
 * (Jaccard); no embeddings, no pgvector. Good enough for personal
 * single-user scope where session counts stay small and the search
 * surface is the agent's last user message.
 */

export interface EpisodicMatch {
  readonly sessionId: string;
  readonly narrative: string;
  readonly similarity?: number;
  readonly createdAtIso?: string;
}

export interface EpisodicRecallSnapshot {
  readonly matches: readonly EpisodicMatch[];
}

export interface EpisodicRecallProvider {
  resolve(query: string, userId?: string): Promise<EpisodicRecallSnapshot | undefined> | EpisodicRecallSnapshot | undefined;
}

const MAX_EPISODIC_CHARS = 1_500;

export function renderEpisodicSection(snapshot: EpisodicRecallSnapshot | undefined): string | undefined {
  if (!snapshot || snapshot.matches.length === 0) {
    return undefined;
  }
  const lines: string[] = ["[Episodic Memory]"];
  lines.push("Past conversations that may be relevant. Soft context — verify before acting.");
  let charsUsed = 0;
  for (const match of snapshot.matches) {
    const header = match.createdAtIso ? `(${match.createdAtIso}, sim=${formatSim(match.similarity)})` : `(sim=${formatSim(match.similarity)})`;
    const remaining = MAX_EPISODIC_CHARS - charsUsed;
    if (remaining <= 0) {
      break;
    }
    const narrative = match.narrative.length > remaining
      ? `${match.narrative.slice(0, Math.max(0, remaining - 1))}…`
      : match.narrative;
    lines.push(`— ${header} ${narrative}`);
    charsUsed += narrative.length;
  }
  return lines.join("\n");
}

function formatSim(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "?";
  }
  return value.toFixed(2);
}

export interface StoredEpisode {
  readonly sessionId: string;
  readonly narrative: string;
  readonly createdAtIso?: string;
  readonly userId?: string;
}

export interface InMemoryEpisodicRecallProviderOptions {
  readonly topK?: number;
  readonly minScore?: number;
  readonly episodes?: readonly StoredEpisode[];
}

/**
 * Token-overlap-based EpisodicRecallProvider. Tokenises lowercase
 * Latin + CJK runs and computes a Jaccard-like overlap score between
 * the user prompt and each stored narrative. No external dependencies,
 * no embedding API call, no pgvector — runs entirely in-process.
 *
 * Trade-off: paraphrase / multi-language semantic matches are weaker
 * than an embedding-backed search. Good enough for personal scope
 * (<100 sessions, single locale). If the corpus grows or
 * cross-language recall becomes important, swap in an
 * embedding-backed provider that satisfies the same
 * `EpisodicRecallProvider` interface — `applyEpisodicRecall` doesn't
 * care which implementation is wired.
 */
export class InMemoryEpisodicRecallProvider implements EpisodicRecallProvider {
  private readonly episodes: StoredEpisode[];
  private readonly topK: number;
  private readonly minScore: number;

  constructor(options: InMemoryEpisodicRecallProviderOptions = {}) {
    this.episodes = [...(options.episodes ?? [])];
    this.topK = Math.max(1, options.topK ?? 3);
    this.minScore = Math.max(0, options.minScore ?? 0.15);
  }

  add(episode: StoredEpisode): void {
    this.episodes.push(episode);
  }

  resolve(query: string, userId?: string): EpisodicRecallSnapshot | undefined {
    const queryTokens = tokenSet(query);
    if (queryTokens.size === 0) {
      return undefined;
    }
    const scored: EpisodicMatch[] = [];
    for (const episode of this.episodes) {
      if (userId && episode.userId && episode.userId !== userId) {
        continue;
      }
      const score = jaccardSimilarity(queryTokens, tokenSet(episode.narrative));
      if (score < this.minScore) {
        continue;
      }
      scored.push({
        createdAtIso: episode.createdAtIso,
        narrative: episode.narrative,
        sessionId: episode.sessionId,
        similarity: score
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const top = scored.slice(0, this.topK);
    if (top.length === 0) {
      return undefined;
    }
    return { matches: top };
  }
}

export function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/u)
      .filter((token) => token.length >= 2)
  );
}

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection++;
    }
  }
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

export interface SummaryListSource {
  listAll?(options?: { readonly userId?: string; readonly limit?: number }):
    | Promise<readonly { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }[]>
    | readonly { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }[];
}

export interface StoreBackedEpisodicRecallProviderOptions {
  readonly store: SummaryListSource;
  readonly topK?: number;
  readonly minScore?: number;
  /** Max summaries fetched per resolve. Default 200. */
  readonly maxFetched?: number;
}

/**
 * EpisodicRecallProvider that lazy-fetches summaries from a
 * `ConversationSummaryStore.listAll`-compatible source on every
 * resolve. Lazy on purpose: new sessions added to the store show up
 * on the next run without restarting the runtime. Jaccard
 * token-overlap scoring — same shape as `InMemoryEpisodicRecallProvider`.
 *
 * Skips silently when the store does not implement `listAll` (e.g.
 * a legacy in-memory store) so the runtime keeps working.
 */
export class StoreBackedEpisodicRecallProvider implements EpisodicRecallProvider {
  private readonly store: SummaryListSource;
  private readonly topK: number;
  private readonly minScore: number;
  private readonly maxFetched: number;

  constructor(options: StoreBackedEpisodicRecallProviderOptions) {
    this.store = options.store;
    this.topK = Math.max(1, options.topK ?? 3);
    this.minScore = Math.max(0, options.minScore ?? 0.15);
    this.maxFetched = Math.max(1, options.maxFetched ?? 200);
  }

  async resolve(query: string, userId?: string): Promise<EpisodicRecallSnapshot | undefined> {
    if (!this.store.listAll) {
      return undefined;
    }
    const queryTokens = tokenSet(query);
    if (queryTokens.size === 0) {
      return undefined;
    }
    let summaries: ReadonlyArray<{ readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }>;
    try {
      summaries = await this.store.listAll({ limit: this.maxFetched, userId });
    } catch {
      return undefined;
    }
    const scored: EpisodicMatch[] = [];
    for (const summary of summaries) {
      if (userId && summary.userId && summary.userId !== userId) {
        continue;
      }
      const score = jaccardSimilarity(queryTokens, tokenSet(summary.narrative));
      if (score < this.minScore) {
        continue;
      }
      scored.push({
        createdAtIso: summary.createdAt?.toISOString(),
        narrative: summary.narrative,
        sessionId: summary.sessionId,
        similarity: score
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const top = scored.slice(0, this.topK);
    return top.length === 0 ? undefined : { matches: top };
  }
}
