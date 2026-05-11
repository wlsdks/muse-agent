/**
 * Episodic recall surface (Context Engineering Phase 3).
 *
 * Provider returns the top-K most-relevant prior conversation summaries
 * given the current user prompt. The actual embedding + cosine-similarity
 * search lives downstream (e.g., `@muse/memory` summary store using
 * pgvector). This file only carries the renderer + the small interface
 * so `agent-core` stays free of vector-store dependencies.
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
 * Token-overlap-based EpisodicRecallProvider — no embeddings needed.
 * Useful as a baseline before the pgvector + embedding path lands.
 * Tokenises lowercase Latin + CJK runs, Jaccard-like overlap score
 * between the user prompt and each episode narrative.
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

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/u)
      .filter((token) => token.length >= 2)
  );
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
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

export interface EmbeddingEpisodicRecallStore {
  findSimilar(
    embedding: readonly number[],
    options?: { readonly userId?: string; readonly topK?: number; readonly minScore?: number }
  ): Promise<readonly { readonly summary: { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }; readonly similarity: number }[]> |
     readonly { readonly summary: { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }; readonly similarity: number }[];
}

export interface EmbeddingClient {
  embed(input: string): Promise<readonly number[]> | readonly number[];
}

export interface EmbeddingEpisodicRecallProviderOptions {
  readonly store: EmbeddingEpisodicRecallStore;
  readonly client: EmbeddingClient;
  readonly topK?: number;
  readonly minScore?: number;
}

/**
 * Embedding-backed EpisodicRecallProvider — preferred over
 * `InMemoryEpisodicRecallProvider` once a pgvector store + embedder
 * are wired up. Embeds the live user prompt, asks the store for
 * top-K similar narratives by cosine similarity, and wraps the
 * result in the `EpisodicRecallSnapshot` shape.
 */
export class EmbeddingEpisodicRecallProvider implements EpisodicRecallProvider {
  private readonly store: EmbeddingEpisodicRecallStore;
  private readonly client: EmbeddingClient;
  private readonly topK: number;
  private readonly minScore: number;

  constructor(options: EmbeddingEpisodicRecallProviderOptions) {
    this.store = options.store;
    this.client = options.client;
    this.topK = Math.max(1, options.topK ?? 3);
    this.minScore = Math.max(0, options.minScore ?? 0.7);
  }

  async resolve(query: string, userId?: string): Promise<EpisodicRecallSnapshot | undefined> {
    if (!query || query.trim().length === 0) {
      return undefined;
    }
    let embedding: readonly number[];
    try {
      embedding = await this.client.embed(query);
    } catch {
      return undefined;
    }
    if (embedding.length === 0) {
      return undefined;
    }
    let results: ReadonlyArray<{ readonly summary: { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }; readonly similarity: number }>;
    try {
      results = await this.store.findSimilar(embedding, {
        minScore: this.minScore,
        topK: this.topK,
        userId
      });
    } catch {
      return undefined;
    }
    if (results.length === 0) {
      return undefined;
    }
    const matches: EpisodicMatch[] = results.map((entry) => ({
      createdAtIso: entry.summary.createdAt?.toISOString(),
      narrative: entry.summary.narrative,
      sessionId: entry.summary.sessionId,
      similarity: entry.similarity
    }));
    return { matches };
  }
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 * Returns 0 when either vector is empty / mismatched.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
