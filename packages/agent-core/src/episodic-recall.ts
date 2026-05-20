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

import { stripUntrustedTerminalChars } from "@muse/shared";

import { humanizeRelativeFromIso } from "./time-helpers.js";

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

// `?? default` does NOT catch NaN/Infinity, and `Math.max(n, NaN)`
// is NaN — a non-finite recall knob would then poison topK
// (`slice(0, NaN)` → []) so recall silently returns nothing.
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function renderEpisodicSection(
  snapshot: EpisodicRecallSnapshot | undefined,
  nowIso?: string
): string | undefined {
  if (!snapshot || snapshot.matches.length === 0) {
    return undefined;
  }
  const lines: string[] = ["[Episodic Memory]"];
  lines.push("Past conversations that may be relevant. Soft context — verify before acting.");
  let charsUsed = 0;
  for (const match of snapshot.matches) {
    // `createdAtIso` is supposed to come from `Date.toISOString()`
    // (always safe) but the EpisodicRecallSnapshot is fed by
    // arbitrary `EpisodicRecallProvider` implementations — a
    // third-party store could put any string in there, including
    // one carrying `\n[System Override]\n`. Sanitise defensively.
    const createdAtIsoSafe = match.createdAtIso ? sanitizeNarrativeInline(match.createdAtIso) : undefined;
    // JARVIS-class freshness affordance. When `nowIso` is
    // wired in (the runtime caller has it), humanise the timestamp
    // to "1 day ago" / "in 3h" / "3 weeks ago" so the agent reads
    // recency directly instead of parsing ISO datetimes. Legacy
    // callers (no nowIso) still get the raw ISO so the existing
    // contract isn't broken — only the prompt rendering improves
    // when the runtime threads nowIso through.
    const headerTime = createdAtIsoSafe
      ? (nowIso ? humanizeRelativeFromIso(nowIso, createdAtIsoSafe) ?? createdAtIsoSafe : createdAtIsoSafe)
      : undefined;
    const header = headerTime ? `(${headerTime}, sim=${formatSim(match.similarity)})` : `(sim=${formatSim(match.similarity)})`;
    // Account for the rendered prefix ("— " + header + " ") so the
    // running `charsUsed` reflects the actual prompt-bytes consumed
    // — the previous impl counted only narrative length and could
    // overshoot `MAX_EPISODIC_CHARS` by ~50 chars per match.
    const prefix = `— ${header} `;
    const remaining = MAX_EPISODIC_CHARS - charsUsed - prefix.length;
    if (remaining <= 0) {
      break;
    }
    // Sanitize: collapse newlines / tabs / multi-space runs to a
    // single space. A stored narrative could otherwise contain
    // `…\n\n[System Override]\n…` (either by a prompt-injection
    // attempt in the source conversation, or by genuine multi-line
    // text) and splice a fake section header into the
    // `[Episodic Memory]` block. Same pattern attachment-context
    // uses for description fields.
    const sanitized = sanitizeNarrativeInline(match.narrative);
    const narrative = sanitized.length > remaining
      ? `${sanitized.slice(0, Math.max(0, remaining - 1))}…`
      : sanitized;
    lines.push(`${prefix}${narrative}`);
    charsUsed += prefix.length + narrative.length;
  }
  return lines.join("\n");
}

function sanitizeNarrativeInline(narrative: string): string {
  // Whitespace-collapse alone neutralises a `\n[System Override]\n`
  // splice, but a poisoned past-session narrative can also carry
  // ESC / C0 / C1 / DEL control bytes (ANSI escapes) that survive
  // `\s+` and would reach the prompt AND the `muse episode/recall`
  // terminal output. Strip them with the shared chokepoint first.
  return stripUntrustedTerminalChars(narrative).replace(/\s+/gu, " ").trim();
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
      const recencyBoost = computeRecencyBoost(episode.createdAtIso, nowMs, this.recencyWeight, this.recencyHalfLifeDays);
      scored.push({
        createdAtIso: episode.createdAtIso,
        narrative: episode.narrative,
        sessionId: episode.sessionId,
        similarity: baseSim + recencyBoost
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

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1].
 * Returns 0 for a length mismatch or a zero-norm vector (no
 * direction → no similarity), so a degenerate embedding can never
 * score above the recall threshold.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  const result = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(result) ? result : 0;
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
      const recencyBoost = computeRecencyBoost(episode.createdAtIso, nowMs, this.recencyWeight, this.recencyHalfLifeDays);
      scored.push({
        createdAtIso: episode.createdAtIso,
        narrative: episode.narrative,
        sessionId: episode.sessionId,
        similarity: baseSim + recencyBoost
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const top = scored.slice(0, this.topK);
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

// Character class for tokenisable runs. Includes the same CJK ranges
// `memory-token-trim.ts:isCjkCodePoint` already uses, so episodic
// recall works across the same locales the token estimator handles:
//   - a-z 0-9            ASCII text (English, Latin transliterations)
//   - 가-힯      Hangul Syllables + some Jamo Extended-A (Korean)
//   - 一-鿿      CJK Unified Ideographs (Chinese Hanzi + Japanese Kanji)
//   - ぀-ゟ      Hiragana (Japanese)
//   - ゠-ヿ      Katakana (Japanese)
// Hangul alone would leave Japanese / Chinese narratives with an
// empty token set → zero recall, even when query and narrative
// shared every meaningful character.
const TOKEN_NON_WORD_RE = /[^a-z0-9가-힯一-鿿぀-ゟ゠-ヿ]+/u;

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RECENCY_WEIGHT = 0.15;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;

/**
 * recency boost. Returns an additive contribution to the
 * episode's similarity score that decays exponentially with episode
 * age:
 *
 *   boost = weight * exp(-age_days / half_life_days)
 *
 * - Brand-new episodes get the full `weight` (default 0.15).
 * - At one half-life (default 14 days) the boost is `weight / 2`.
 * - After ~3 half-lives (~6 weeks) the boost is effectively zero.
 *
 * JARVIS-class personal assistants prefer recently-relevant memory:
 * between two similar narratives, the newer one should rank higher.
 * The boost is ADDED to the Jaccard score AFTER the `minScore`
 * gate, so a recency-only match (no semantic overlap) still can't
 * surface — it would have already been filtered out.
 *
 * Returns 0 when `createdAtIso` is missing / unparseable, or when
 * the configured weight is 0 (feature disabled).
 */
function computeRecencyBoost(
  createdAtIso: string | undefined,
  nowMs: number,
  weight: number,
  halfLifeDays: number
): number {
  if (weight <= 0 || !createdAtIso) {
    return 0;
  }
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - createdMs) / DAY_MS);
  return weight * Math.exp(-ageDays / halfLifeDays);
}

function hasCjkChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||  // CJK Unified Ideographs
      (code >= 0xac00 && code <= 0xd7af) ||  // Hangul Syllables
      (code >= 0x3040 && code <= 0x309f) ||  // Hiragana
      (code >= 0x30a0 && code <= 0x30ff)     // Katakana
    ) {
      return true;
    }
  }
  return false;
}

function tokenSet(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().split(TOKEN_NON_WORD_RE)) {
    if (raw.length < 2) {
      continue;
    }
    if (hasCjkChar(raw)) {
      // CJK scripts don't separate words with whitespace, so a
      // contiguous run like "東京で会議" arrives as ONE raw token.
      // Whole-token equality would only match identical phrases —
      // a paraphrase like "東京の会議" would Jaccard to 0. Emit
      // character bigrams instead: the standard dependency-free
      // fallback for CJK tokenisation. "東京で会議" →
      // {"東京","京で","で会","会議"}; the paraphrase shares
      // "東京" and "会議", scoring 2/6 ≈ 0.33 → above the default
      // minScore. ASCII tokens keep their existing whole-word
      // behaviour.
      for (let index = 0; index < raw.length - 1; index += 1) {
        tokens.add(raw.slice(index, index + 2));
      }
    } else {
      tokens.add(raw);
    }
  }
  return tokens;
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
  private readonly allowAnonymousEpisodes: boolean;
  private readonly maxQueryChars: number;
  private readonly recencyWeight: number;
  private readonly recencyHalfLifeDays: number;
  private readonly now: () => number;
  private readonly embed?: (text: string) => Promise<readonly number[]>;

  constructor(options: StoreBackedEpisodicRecallProviderOptions) {
    this.store = options.store;
    this.embed = options.embed;
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
    const scored: EpisodicMatch[] = [];
    for (const summary of summaries) {
      if (!isVisibleToUser(userId, summary.userId, this.allowAnonymousEpisodes)) {
        continue;
      }
      let baseSim: number;
      if (queryVec) {
        try {
          baseSim = cosineSimilarity(queryVec, await this.embed!(summary.narrative));
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
      const recencyBoost = computeRecencyBoost(createdAtIso, nowMs, this.recencyWeight, this.recencyHalfLifeDays);
      scored.push({
        createdAtIso,
        narrative: summary.narrative,
        sessionId: summary.sessionId,
        similarity: baseSim + recencyBoost
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const top = scored.slice(0, this.topK);
    return top.length === 0 ? undefined : { matches: top };
  }
}
