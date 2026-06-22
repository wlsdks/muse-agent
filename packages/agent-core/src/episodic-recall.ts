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

import { approximateActivationBoost } from "./actr-activation.js";
import {
  applyLateralInhibition,
  consolidateNearDuplicates,
  cosineSimilarity,
  episodeTimeBoost,
  computeRecencyBoost,
  EPISODIC_INHIBITION_STRENGTH,
  flagEpisodicConflicts,
  jaccardSimilarity,
  selectByClusterTransition,
  tokenSet
} from "./episodic-ranking.js";

export {
  applyLateralInhibition,
  consolidateNearDuplicates,
  cosineSimilarity,
  EPISODIC_CLUSTER_DROP_RATIO,
  EPISODIC_CONSOLIDATION_THRESHOLD,
  EPISODIC_INHIBITION_STRENGTH,
  flagEpisodicConflicts,
  selectByClusterTransition
} from "./episodic-ranking.js";
export type { EpisodicConflictFlag } from "./episodic-ranking.js";
export { renderEpisodicSection } from "./episodic-render.js";

export interface EpisodicMatch {
  readonly sessionId: string;
  readonly narrative: string;
  readonly similarity?: number;
  /**
   * The Ebbinghaus-faded score used for SORT ORDER ONLY. The fade penalty is a
   * non-destructive down-rank (see the fade comment in the provider): it must
   * never push a match below `minScore` and exclude it, so the minScore gate
   * runs on `similarity` (pre-penalty) while ordering uses this. Absent when no
   * fade applies, in which case order falls back to `similarity`.
   */
  readonly sortScore?: number;
  readonly createdAtIso?: string;
  /**
   * Set by the A-MAC factual-confidence pass (arXiv:2603.04549) when this
   * recalled episode states the SAME topic but a DIFFERENT value than a
   * higher-relevance recalled episode. Carries that episode's sessionId so the
   * renderer can mark the conflict — moving reconciliation from a fragile
   * prompt instruction into DATA. Read-time annotation only; never drops.
   */
  readonly conflictsWith?: string;
}

export interface EpisodicRecallSnapshot {
  readonly matches: readonly EpisodicMatch[];
}

export interface EpisodicRecallProvider {
  resolve(query: string, userId?: string): Promise<EpisodicRecallSnapshot | undefined> | EpisodicRecallSnapshot | undefined;
}

// `?? default` does NOT catch NaN/Infinity, and `Math.max(n, NaN)`
// is NaN — a non-finite recall knob would then poison topK
// (`slice(0, NaN)` → []) so recall silently returns nothing.
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export interface StoredEpisode {
  readonly sessionId: string;
  readonly narrative: string;
  readonly createdAtIso?: string;
  readonly userId?: string;
  /**
   * Recall-access timestamps. When present, ranking uses ACT-R base-level
   * activation over the full history (frequency × recency × spacing) instead
   * of the single-creation-time half-life decay.
   */
  readonly accessTimesIso?: readonly string[];
}

export interface InMemoryEpisodicRecallProviderOptions {
  readonly topK?: number;
  readonly minScore?: number;
  readonly episodes?: readonly StoredEpisode[];
  /**
   * When a request carries a `userId` but a stored episode has none,
   * default behaviour is to **skip** that episode — anonymous /
   * legacy data must not leak across users.
   *
   * Set `allowAnonymousEpisodes: true` to treat episodes with no
   * `userId` as globally visible (the previous behaviour, kept for
   * single-user setups that pre-date per-user scoping).
   */
  readonly allowAnonymousEpisodes?: boolean;
  /**
   * Cap the user-prompt characters consumed by tokenisation so an
   * accidentally huge user message can't blow CPU on the recall
   * path. Defaults to 4_096 — enough for any realistic prompt,
   * short enough to bound the Jaccard inner loop.
   */
  readonly maxQueryChars?: number;
  /**
   * recency boost weight (max addition to a semantic
   * score, decays exponentially with episode age). JARVIS-class
   * personal assistants prefer recently-relevant memory: between
   * two similar narratives, the newer one should win.
   *
   * Default 0.15. Set to 0 to disable.
   */
  readonly recencyWeight?: number;
  /**
   * Half-life in days for the recency boost. Default 14: an
   * episode 14 days old contributes half the boost a brand-new
   * episode does. After ~3 half-lives (≈ 6 weeks) the boost is
   * effectively zero.
   */
  readonly recencyHalfLifeDays?: number;
  /**
   * Injectable clock; defaults to `Date.now()`. Test-only.
   */
  readonly now?: () => number;
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
  private readonly allowAnonymousEpisodes: boolean;
  private readonly maxQueryChars: number;
  private readonly recencyWeight: number;
  private readonly recencyHalfLifeDays: number;
  private readonly now: () => number;

  constructor(options: InMemoryEpisodicRecallProviderOptions = {}) {
    this.episodes = [...(options.episodes ?? [])];
    this.topK = Math.max(1, finiteOr(options.topK, 3));
    this.minScore = Math.max(0, finiteOr(options.minScore, 0.15));
    this.allowAnonymousEpisodes = options.allowAnonymousEpisodes ?? false;
    this.maxQueryChars = Math.max(64, finiteOr(options.maxQueryChars, 4_096));
    this.recencyWeight = Math.max(0, finiteOr(options.recencyWeight, DEFAULT_RECENCY_WEIGHT));
    this.recencyHalfLifeDays = Math.max(0.01, finiteOr(options.recencyHalfLifeDays, DEFAULT_RECENCY_HALF_LIFE_DAYS));
    this.now = options.now ?? (() => Date.now());
  }

  add(episode: StoredEpisode): void {
    this.episodes.push(episode);
  }

  resolve(query: string, userId?: string): EpisodicRecallSnapshot | undefined {
    const bounded = query.length > this.maxQueryChars ? query.slice(0, this.maxQueryChars) : query;
    const queryTokens = tokenSet(bounded);
    if (queryTokens.size === 0) {
      return undefined;
    }
    const nowMs = this.now();
    const scored: EpisodicMatch[] = [];
    for (const episode of this.episodes) {
      if (!isVisibleToUser(userId, episode.userId, this.allowAnonymousEpisodes)) {
        continue;
      }
      const baseSim = jaccardSimilarity(queryTokens, tokenSet(episode.narrative));
      // Threshold guards baseSim ONLY — a recency-only match (no
      // semantic overlap) must not surface, otherwise every recent
      // session would muscle its way into the recall regardless of
      // relevance.
      if (baseSim < this.minScore) {
        continue;
      }
      const recencyBoost = episodeTimeBoost(episode, nowMs, this.recencyWeight, this.recencyHalfLifeDays);
      scored.push({
        createdAtIso: episode.createdAtIso,
        narrative: episode.narrative,
        sessionId: episode.sessionId,
        similarity: baseSim + recencyBoost
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const k = selectByClusterTransition(scored.map((m) => m.similarity ?? 0), { topK: this.topK });
    const top = scored.slice(0, k);
    if (top.length === 0) {
      return undefined;
    }
    return { matches: top };
  }
}

export interface EmbeddingEpisodicRecallProviderOptions {
  /** Embeds query / narrative text to a vector. Local (zero-cost). */
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly minScore?: number;
  readonly episodes?: readonly StoredEpisode[];
  readonly allowAnonymousEpisodes?: boolean;
  readonly maxQueryChars?: number;
  readonly recencyWeight?: number;
  readonly recencyHalfLifeDays?: number;
  readonly now?: () => number;
}

/**
 * Embedding-similarity `EpisodicRecallProvider`: ranks stored
 * narratives by cosine similarity to the query embedding instead of
 * Jaccard token overlap, so a paraphrase that shares NO tokens with
 * the narrative still recalls it (the Jaccard provider scores such a
 * query 0 and misses it). Same recency boost / threshold / per-user
 * visibility / topK as `InMemoryEpisodicRecallProvider` — only the
 * scorer changes. `embed` is injected (local Ollama in production —
 * zero-cost; a deterministic fake in tests).
 */
export class EmbeddingEpisodicRecallProvider implements EpisodicRecallProvider {
  private readonly embed: (text: string) => Promise<readonly number[]>;
  private readonly episodes: StoredEpisode[];
  private readonly topK: number;
  private readonly minScore: number;
  private readonly allowAnonymousEpisodes: boolean;
  private readonly maxQueryChars: number;
  private readonly recencyWeight: number;
  private readonly recencyHalfLifeDays: number;
  private readonly now: () => number;

  constructor(options: EmbeddingEpisodicRecallProviderOptions) {
    this.embed = options.embed;
    this.episodes = [...(options.episodes ?? [])];
    this.topK = Math.max(1, finiteOr(options.topK, 3));
    this.minScore = Math.max(0, finiteOr(options.minScore, 0.15));
    this.allowAnonymousEpisodes = options.allowAnonymousEpisodes ?? false;
    this.maxQueryChars = Math.max(64, finiteOr(options.maxQueryChars, 4_096));
    this.recencyWeight = Math.max(0, finiteOr(options.recencyWeight, DEFAULT_RECENCY_WEIGHT));
    this.recencyHalfLifeDays = Math.max(0.01, finiteOr(options.recencyHalfLifeDays, DEFAULT_RECENCY_HALF_LIFE_DAYS));
    this.now = options.now ?? (() => Date.now());
  }

  add(episode: StoredEpisode): void {
    this.episodes.push(episode);
  }

  async resolve(query: string, userId?: string): Promise<EpisodicRecallSnapshot | undefined> {
    const bounded = query.length > this.maxQueryChars ? query.slice(0, this.maxQueryChars) : query;
    if (bounded.trim().length === 0) {
      return undefined;
    }
    const visible = this.episodes.filter((episode) =>
      isVisibleToUser(userId, episode.userId, this.allowAnonymousEpisodes)
    );
    if (visible.length === 0) {
      return undefined;
    }
    const queryVec = await this.embed(bounded);
    const nowMs = this.now();
    const scored: EpisodicMatch[] = [];
    for (const episode of visible) {
      const baseSim = cosineSimilarity(queryVec, await this.embed(episode.narrative));
      if (baseSim < this.minScore) {
        continue;
      }
      const recencyBoost = episodeTimeBoost(episode, nowMs, this.recencyWeight, this.recencyHalfLifeDays);
      scored.push({
        createdAtIso: episode.createdAtIso,
        narrative: episode.narrative,
        sessionId: episode.sessionId,
        similarity: baseSim + recencyBoost
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const k = selectByClusterTransition(scored.map((m) => m.similarity ?? 0), { topK: this.topK });
    const top = scored.slice(0, k);
    return top.length === 0 ? undefined : { matches: top };
  }
}

/**
 * Multi-user safety predicate. When a request carries no userId
 * (single-user setup), everything is visible. When a request DOES
 * carry a userId, the episode must either match it OR — when the
 * caller has explicitly opted in via `allowAnonymous` — be anonymous
 * (no recorded userId). Episodes belonging to a *different* user are
 * always hidden.
 */
function isVisibleToUser(
  requestUserId: string | undefined,
  episodeUserId: string | undefined,
  allowAnonymous: boolean
): boolean {
  if (!requestUserId) {
    return true;
  }
  if (episodeUserId === requestUserId) {
    return true;
  }
  if (!episodeUserId && allowAnonymous) {
    return true;
  }
  return false;
}

const DEFAULT_RECENCY_WEIGHT = 0.15;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
// Ebbinghaus penalty for sessions the consolidation pass flagged as fading.
// Applied post-minScore-gate so it can only LOWER a surviving session, never
// add or remove one from the candidate set (arXiv:2305.10250, MemoryBank).
const FADE_PENALTY = 0.5;
// Reinstatement window: a faded session re-recalled within this span has its
// fade penalty WAIVED — reconsolidation on re-access (mem0: decay UNLESS
// reinforced). Sized to the ≥6h daemon consolidation interval that writes the
// fade file, so a still-recalled key is never down-ranked while the live
// recall ledger already shows re-engagement. Tune on real recall distribution.
const FADE_REINSTATE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/**
 * True when a recall-stats entry shows a re-access within `windowMs` of `nowMs`.
 * Fail-open: a missing entry or absent `lastHitMs` returns false (no waiver →
 * identical to pre-reinstatement behaviour).
 */
function isRecentlyReengaged(
  statsEntry: { readonly lastHitMs?: number } | undefined,
  nowMs: number,
  windowMs: number
): boolean {
  if (!statsEntry || typeof statsEntry.lastHitMs !== "number") {
    return false;
  }
  return nowMs - statsEntry.lastHitMs <= windowMs;
}

/**
 * Apply {@link flagEpisodicConflicts} as `conflictsWith` annotations on the
 * matches. Returns the same array (new objects only for flagged matches) so the
 * renderer can surface the conflict. Never drops or reorders.
 */
export function annotateEpisodicConflicts(
  matches: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>
): EpisodicMatch[] {
  const flags = flagEpisodicConflicts(matches, narrativeVecs);
  if (flags.length === 0) {
    return [...matches];
  }
  const byId = new Map(flags.map((f) => [f.sessionId, f.conflictsWith]));
  return matches.map((m) => {
    const conflictsWith = byId.get(m.sessionId);
    return conflictsWith ? { ...m, conflictsWith } : m;
  });
}

export interface SummaryListSource {
  listAll?(options?: { readonly userId?: string; readonly limit?: number }):
    | Promise<readonly { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }[]>
    | readonly { readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }[];
}

export interface StoreBackedEpisodicRecallProviderOptions {
  readonly store: SummaryListSource;
  /**
   * Recall-hit stats per sessionId (from the recall-hits ledger). When
   * supplied, ranking uses ACT-R activation (frequency × recency over the
   * episode's recall history) instead of the creation-time half-life alone.
   */
  readonly recallStats?: () =>
    | Promise<ReadonlyMap<string, { readonly hits: number; readonly lastHitMs: number }>>
    | ReadonlyMap<string, { readonly hits: number; readonly lastHitMs: number }>;
  readonly topK?: number;
  readonly minScore?: number;
  /** Max summaries fetched per resolve. Default 200. */
  readonly maxFetched?: number;
  /**
   * When a request carries a `userId` but a stored summary has none,
   * default behaviour is to **skip** that summary — anonymous /
   * legacy data must not leak across users.
   */
  readonly allowAnonymousEpisodes?: boolean;
  /** Cap on user-prompt tokenisation input. Default 4_096 chars. */
  readonly maxQueryChars?: number;
  /** Recency boost weight. See `InMemoryEpisodicRecallProviderOptions`. */
  readonly recencyWeight?: number;
  /** Recency half-life in days. */
  readonly recencyHalfLifeDays?: number;
  /** Injectable clock (test only). */
  readonly now?: () => number;
  /**
   * When set, narratives are ranked by cosine similarity to the
   * query embedding instead of Jaccard token overlap — so a
   * paraphrase with no shared tokens still recalls the right
   * memory. Zero-cost local Ollama in production. Fail-open: if the
   * embedder throws (Ollama down / model missing) this resolve
   * silently falls back to Jaccard so recall never breaks.
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /**
   * Ebbinghaus closed forgetting loop (arXiv:2305.10250, MemoryBank): sessions
   * the consolidation pass marked as fading (decayed + idle) are down-ranked by
   * FADE_PENALTY applied to their similarity score. Fail-open — a loader error
   * or corrupt sidecar is treated as an empty set so ranking is unchanged.
   * Down-rank only, never delete (Muse's non-destructive contract).
   */
  readonly fadedKeys?: () => Promise<ReadonlySet<string>> | ReadonlySet<string>;
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
  private readonly recallStatsLoader?: StoreBackedEpisodicRecallProviderOptions["recallStats"];
  private readonly store: SummaryListSource;
  private readonly topK: number;
  private readonly minScore: number;
  private readonly maxFetched: number;
  private readonly allowAnonymousEpisodes: boolean;
  private readonly maxQueryChars: number;
  private readonly recencyWeight: number;
  private readonly recencyHalfLifeDays: number;
  private readonly now: () => number;
  private readonly embed?: (text: string) => Promise<readonly number[]>;
  private readonly fadedKeysLoader?: StoreBackedEpisodicRecallProviderOptions["fadedKeys"];

  constructor(options: StoreBackedEpisodicRecallProviderOptions) {
    this.recallStatsLoader = options.recallStats;
    this.store = options.store;
    this.embed = options.embed;
    this.fadedKeysLoader = options.fadedKeys;
    this.topK = Math.max(1, finiteOr(options.topK, 3));
    this.minScore = Math.max(0, finiteOr(options.minScore, 0.15));
    this.maxFetched = Math.max(1, finiteOr(options.maxFetched, 200));
    this.allowAnonymousEpisodes = options.allowAnonymousEpisodes ?? false;
    this.maxQueryChars = Math.max(64, finiteOr(options.maxQueryChars, 4_096));
    this.recencyWeight = Math.max(0, finiteOr(options.recencyWeight, DEFAULT_RECENCY_WEIGHT));
    this.recencyHalfLifeDays = Math.max(0.01, finiteOr(options.recencyHalfLifeDays, DEFAULT_RECENCY_HALF_LIFE_DAYS));
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(query: string, userId?: string): Promise<EpisodicRecallSnapshot | undefined> {
    if (!this.store.listAll) {
      return undefined;
    }
    const bounded = query.length > this.maxQueryChars ? query.slice(0, this.maxQueryChars) : query;
    const queryTokens = tokenSet(bounded);
    if (queryTokens.size === 0) {
      return undefined;
    }
    let summaries: ReadonlyArray<{ readonly sessionId: string; readonly narrative: string; readonly createdAt?: Date; readonly userId?: string }>;
    try {
      summaries = await this.store.listAll({ limit: this.maxFetched, userId });
    } catch {
      return undefined;
    }
    // Fail-open: a thrown embedder (Ollama down / model missing)
    // must degrade to Jaccard, never break recall.
    let queryVec: readonly number[] | undefined;
    if (this.embed) {
      try {
        queryVec = await this.embed(bounded);
      } catch {
        queryVec = undefined;
      }
    }
    const nowMs = this.now();
    let recallStats: ReadonlyMap<string, { readonly hits: number; readonly lastHitMs: number }> | undefined;
    if (this.recallStatsLoader) {
      try {
        recallStats = await this.recallStatsLoader();
      } catch {
        recallStats = undefined;
      }
    }
    let fadedKeys: ReadonlySet<string>;
    if (this.fadedKeysLoader) {
      try {
        fadedKeys = await this.fadedKeysLoader();
      } catch {
        fadedKeys = new Set();
      }
    } else {
      fadedKeys = new Set();
    }
    const scored: EpisodicMatch[] = [];
    const narrativeVecs = new Map<string, readonly number[]>();
    for (const summary of summaries) {
      if (!isVisibleToUser(userId, summary.userId, this.allowAnonymousEpisodes)) {
        continue;
      }
      let baseSim: number;
      if (queryVec) {
        try {
          const narrativeVec = await this.embed!(summary.narrative);
          narrativeVecs.set(summary.sessionId, narrativeVec);
          baseSim = cosineSimilarity(queryVec, narrativeVec);
        } catch {
          baseSim = jaccardSimilarity(queryTokens, tokenSet(summary.narrative));
        }
      } else {
        baseSim = jaccardSimilarity(queryTokens, tokenSet(summary.narrative));
      }
      if (baseSim < this.minScore) {
        continue;
      }
      const createdAtIso = summary.createdAt?.toISOString();
      const stats = recallStats?.get(summary.sessionId);
      // ACT-R activation over the recall-hit history when the ledger has it;
      // the legacy creation-time half-life otherwise (identical to before).
      const recencyBoost = stats
        ? approximateActivationBoost(
            { createdMs: summary.createdAt?.getTime() ?? stats.lastHitMs, hits: stats.hits, lastHitMs: stats.lastHitMs },
            nowMs,
            this.recencyWeight
          )
        : computeRecencyBoost(createdAtIso, nowMs, this.recencyWeight, this.recencyHalfLifeDays);
      // Ebbinghaus down-rank: a session the consolidation pass marked fading
      // has its similarity halved (post-gate, so it can never suppress a match
      // that would otherwise be excluded, only lower a surviving one). Carve-out:
      // the fade file lags the live recall ledger by up to a consolidation tick,
      // so waive the penalty when recallStats shows the session was re-recalled
      // within the reinstatement window (reconsolidation on re-access). The
      // penalty is only ever waived, never made harsher; fail-open when stats
      // are absent.
      const fadePenalty =
        fadedKeys.has(summary.sessionId) &&
        !isRecentlyReengaged(recallStats?.get(summary.sessionId), nowMs, FADE_REINSTATE_MAX_AGE_MS)
          ? FADE_PENALTY
          : 1;
      const preFadeScore = baseSim + recencyBoost;
      scored.push({
        createdAtIso,
        narrative: summary.narrative,
        sessionId: summary.sessionId,
        similarity: preFadeScore,
        sortScore: preFadeScore * fadePenalty
      });
    }
    scored.sort((a, b) => (b.sortScore ?? b.similarity ?? 0) - (a.sortScore ?? a.similarity ?? 0));
    const consolidated = consolidateNearDuplicates(scored, narrativeVecs);
    const adaptiveK = selectByClusterTransition(consolidated.map((m) => m.sortScore ?? m.similarity ?? 0), { topK: this.topK });
    const strength = narrativeVecs.size > 0 ? EPISODIC_INHIBITION_STRENGTH : 0;
    const top = applyLateralInhibition(consolidated, narrativeVecs, {
      topK: adaptiveK,
      minScore: this.minScore,
      inhibitionStrength: strength
    });
    if (top.length === 0) {
      return undefined;
    }
    // A-MAC factual-confidence (arXiv:2603.04549): annotate a surviving episode
    // that contradicts a higher-relevance one, reusing the embeddings already
    // computed above (no extra embed calls). Annotation-only, fail-soft.
    return { matches: annotateEpisodicConflicts(top, narrativeVecs) };
  }
}
