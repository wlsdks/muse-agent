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

import { approximateActivationBoost, computeActivationBoost } from "./actr-activation.js";
import { comparableScript } from "./script-family.js";
import { humanizeRelativeFromIso } from "./time-helpers.js";

export interface EpisodicMatch {
  readonly sessionId: string;
  readonly narrative: string;
  readonly similarity?: number;
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
    // A-MAC conflict marker: a same-topic-different-value episode is flagged so
    // the model reconciles instead of asserting one value confidently. Counted
    // into the budget so the marker can't silently overshoot MAX_EPISODIC_CHARS.
    const conflictMark = match.conflictsWith
      ? " ⚠ conflicts with a more relevant memory — verify"
      : "";
    const remaining = MAX_EPISODIC_CHARS - charsUsed - prefix.length - conflictMark.length;
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
    lines.push(`${prefix}${narrative}${conflictMark}`);
    charsUsed += prefix.length + narrative.length + conflictMark.length;
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
function episodeTimeBoost(
  episode: StoredEpisode,
  nowMs: number,
  weight: number,
  halfLifeDays: number
): number {
  if (episode.accessTimesIso && episode.accessTimesIso.length > 0) {
    const times = [episode.createdAtIso, ...episode.accessTimesIso]
      .map((iso) => (iso ? Date.parse(iso) : Number.NaN))
      .filter((ms) => Number.isFinite(ms));
    return computeActivationBoost(times, nowMs, weight);
  }
  return computeRecencyBoost(episode.createdAtIso, nowMs, weight, halfLifeDays);
}

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

// WHY inhibition ≠ MMR: MMR reorders for diversity, displacing a relevant
// item with a less-relevant one to maximise coverage. Lateral inhibition
// (arXiv:2601.02744) demotes a REDUNDANT candidate's score by its cosine
// similarity to an already-selected stronger-activation match, then
// re-applies the existing minScore gate. A non-redundant relevant episode
// is never displaced; only near-duplicates that crowd out distinct memory
// are suppressed. Winner-take-most, fail-soft: empty vecs or strength 0
// produce output byte-identical to a plain topK slice.
export const EPISODIC_INHIBITION_STRENGTH = 0.5;

// WHY relative-drop (CAR arXiv:2511.14769) vs absolute-max-gap (selectByScoreGap):
// selectByScoreGap finds the single LARGEST absolute consecutive gap across all
// scores — scale-dependent, so a uniform fade multiplier shifts the cliff.
// selectByClusterTransition tests each adjacent pair with a RELATIVE ratio
// so a uniform multiplier (e.g. FADE_PENALTY) leaves relative drops unchanged;
// only a true relevance cliff (next item < half the previous) triggers the cut.
// WHY 0.5 conservative: at 50% drop the cliff is sharp and unambiguous — marginal
// episodes that are still somewhat relevant (e.g. 0.6 → 0.4, a 33% drop) survive.
// Erring toward today's topK is the right default; a cliff that aggressive is
// almost certainly a true relevance boundary. (CAR arXiv:2511.14769)
export const EPISODIC_CLUSTER_DROP_RATIO = 0.5;

// WHY 0.92: Mem0 near-equivalence threshold (arXiv:2504.19413, Chhikara et al. 2025).
// Conservative so only TRUE near-duplicates (two summaries of the same decision,
// near-identical wording) collapse; a related-but-distinct pair (cosine ~0.6) keeps
// both. Distinct from lateral-inhibition (which DEMOTES the 2nd dup's SCORE but
// never frees the slot — iterates the pre-sorted list and a demoted item still
// occupies a position) and CAR (which detects a SCORE-SEQUENCE cliff, not CONTENT
// duplication between two adjacent high scores). Placed BEFORE CAR so adaptiveK
// is computed on the deduplicated list, freeing a slot for a distinct episode.
export const EPISODIC_CONSOLIDATION_THRESHOLD = 0.92;

/**
 * Retrieval-time near-duplicate consolidation (Mem0, arXiv:2504.19413).
 *
 * Walks `scored` high→low (already sorted); for each candidate computes the max
 * cosine similarity to every already-kept episode. If that max is ≥ threshold the
 * candidate is the lower-ranked near-duplicate and is dropped (consolidated into
 * the stronger-ranked kept one). Otherwise it is kept.
 *
 * SELECTION-ONLY: only drops a near-identical lower-ranked duplicate; never adds a
 * below-minScore episode, never fabricates, never reorders by anything but the
 * existing sort. Fail-soft: empty map OR a candidate/selected missing a vec →
 * 0 similarity → never falsely collapses; pure and deterministic, never throws.
 */
export function consolidateNearDuplicates(
  scored: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>,
  threshold = EPISODIC_CONSOLIDATION_THRESHOLD
): EpisodicMatch[] {
  if (narrativeVecs.size === 0) {
    return [...scored];
  }
  const kept: EpisodicMatch[] = [];
  for (const candidate of scored) {
    const candVec = narrativeVecs.get(candidate.sessionId);
    if (!candVec) {
      kept.push(candidate);
      continue;
    }
    let maxCos = 0;
    for (const sel of kept) {
      const selVec = narrativeVecs.get(sel.sessionId);
      if (selVec) {
        const sim = cosineSimilarity(candVec, selVec);
        if (sim > maxCos) {
          maxCos = sim;
        }
      }
    }
    if (maxCos < threshold) {
      kept.push(candidate);
    }
  }
  return kept;
}

// WHY 0.86 (topic gate) sits BELOW 0.92 (consolidation): a value-conflict pair
// ("flight at 3pm" vs "flight at 6pm") is the SAME topic but NOT a near-duplicate
// — it lands in the [0.86, 0.92) band, so consolidation keeps both and this pass
// flags the lower-relevance one. A pair ≥0.92 was already collapsed (one survives,
// nothing to reconcile). 0.5 statement-overlap = the two share the statement
// skeleton (Mem0 arXiv:2504.19413 / A-MAC arXiv:2603.04549).
const EPISODIC_CONFLICT_TOPIC_SIM_MIN = 0.86;
const EPISODIC_CONFLICT_STATEMENT_OVERLAP_MIN = 0.5;

/**
 * A recalled episode that states the SAME topic but a DIFFERENT value than a
 * higher-relevance recalled episode. `sessionId` is the lower-relevance episode
 * (the one to annotate); `conflictsWith` is the higher-relevance one.
 */
export interface EpisodicConflictFlag {
  readonly sessionId: string;
  readonly conflictsWith: string;
  readonly topicSim: number;
}

/**
 * A-MAC factual-confidence pass (arXiv:2603.04549): flag recalled episodes that
 * CONTRADICT a higher-relevance recalled episode, so reconciliation moves from a
 * fragile prompt instruction into DATA. `matches` are assumed sorted by relevance
 * desc (the providers sort before this runs), so for each conflicting pair the
 * EARLIER index is higher-relevance and the LATER is flagged.
 *
 * The signal (precision-first — when unsure, flags nothing):
 * 1. Same-script guard (cross-lingual value-comparison is unreliable — the
 *    recurring lesson; a missed cross-lingual conflict = today's behaviour).
 * 2. Topic gate: cosine on the ALREADY-COMPUTED narrative vecs ≥ topicSimMin.
 *    Semantic, not lexical — the primary signal.
 * 3. HIGH token overlap (shared statement skeleton) + neither-subset (each has
 *    ≥1 content token the other lacks → a genuine value-conflict, not an
 *    elaboration). Lexical only as the secondary value-conflict discriminator,
 *    guarded by step 1 — mirrors the proven detectEvidenceContradictions.
 *
 * One flag per lower-relevance episode (its highest-relevance conflicting
 * partner). ANNOTATION-only: never drops, never reorders, never widens grounding.
 * Fail-soft: empty vecs OR a missing vec → no flag → today's behaviour. Pure,
 * synchronous (reuses precomputed embeddings), never throws, never calls an LLM.
 */
export function flagEpisodicConflicts(
  matches: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly statementOverlapMin?: number }
): readonly EpisodicConflictFlag[] {
  const topicSimMin = opts?.topicSimMin ?? EPISODIC_CONFLICT_TOPIC_SIM_MIN;
  const statementOverlapMin = opts?.statementOverlapMin ?? EPISODIC_CONFLICT_STATEMENT_OVERLAP_MIN;
  if (matches.length < 2 || narrativeVecs.size === 0) {
    return [];
  }
  const flags: EpisodicConflictFlag[] = [];
  for (let j = 1; j < matches.length; j++) {
    const lower = matches[j]!;
    const lowerVec = narrativeVecs.get(lower.sessionId);
    if (!lowerVec) continue;
    const tokLower = tokenSet(lower.narrative);
    for (let i = 0; i < j; i++) {
      const higher = matches[i]!;
      const higherVec = narrativeVecs.get(higher.sessionId);
      if (!higherVec) continue;
      if (!comparableScript(higher.narrative, lower.narrative)) continue;
      const topicSim = cosineSimilarity(higherVec, lowerVec);
      if (topicSim < topicSimMin) continue;
      const tokHigher = tokenSet(higher.narrative);
      const unionSize = new Set([...tokHigher, ...tokLower]).size;
      if (unionSize === 0) continue;
      let intersect = 0;
      for (const t of tokHigher) {
        if (tokLower.has(t)) intersect++;
      }
      if (intersect / unionSize < statementOverlapMin) continue;
      // Neither-subset: an elaboration (one set ⊆ the other) is not a conflict.
      if (tokHigher.size - intersect === 0 || tokLower.size - intersect === 0) continue;
      flags.push({ sessionId: lower.sessionId, conflictsWith: higher.sessionId, topicSim });
      break; // highest-relevance partner wins; one flag per lower episode
    }
  }
  return flags;
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

/**
 * Adaptive top-k cutoff via cluster-transition detection (CAR, arXiv:2511.14769).
 *
 * Walks already-sorted (high→low) scores and returns k = the index after the FIRST
 * pair where the next score is less than `(1 - dropRatio)` of the current —
 * i.e. a relative drop sharp enough to signal a cluster boundary.
 *
 * SELECTION-ONLY: result is always ≤ topK. Never adds an episode. Fail-soft: if no
 * transition is found, or inputs are degenerate, returns topK (byte-identical to the
 * previous fixed slice). Distinct from selectByScoreGap which finds the largest
 * ABSOLUTE gap; this uses a RELATIVE drop ratio so a uniform fade multiplier (which
 * scales all scores proportionally) does NOT move the cut.
 */
export function selectByClusterTransition(
  scoresDescending: readonly number[],
  options: { readonly topK: number; readonly dropRatio?: number }
): number {
  const n = scoresDescending.length;
  if (n === 0) return 0;
  const { topK } = options;
  const dropRatio = typeof options.dropRatio === "number" && Number.isFinite(options.dropRatio)
    ? options.dropRatio
    : EPISODIC_CLUSTER_DROP_RATIO;
  // Any non-finite (NaN/Infinity) or negative score in the array means we can't
  // reason reliably about relative drops — fail-soft to topK.
  for (let i = 0; i < Math.min(n, topK); i++) {
    const s = scoresDescending[i] ?? 0;
    if (!Number.isFinite(s) || s < 0) {
      return topK;
    }
  }
  for (let i = 0; i < Math.min(n - 1, topK - 1); i++) {
    const cur = scoresDescending[i] ?? 0;
    const next = scoresDescending[i + 1] ?? 0;
    if (next < cur * (1 - dropRatio)) {
      return i + 1;
    }
  }
  // No transition found: return the actual available count capped at topK.
  return Math.min(n, topK);
}

/**
 * Greedy lateral-inhibition pass over pre-sorted episodic matches.
 *
 * For each candidate (highest-score first), compute the penalty from
 * its cosine similarity to already-selected episodes. If the inhibited
 * score still clears `minScore`, accept; otherwise drop. Stops at topK.
 *
 * narrativeVecs must be keyed by `EpisodicMatch.sessionId`. Any
 * candidate or selected episode without a vec entry contributes 0
 * similarity to the penalty (safe, not an error).
 */
export function applyLateralInhibition(
  scored: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>,
  options: { topK: number; minScore: number; inhibitionStrength: number }
): EpisodicMatch[] {
  const { topK, minScore, inhibitionStrength } = options;
  if (inhibitionStrength === 0 || narrativeVecs.size === 0) {
    return scored.filter((m) => (m.similarity ?? 0) >= minScore).slice(0, topK);
  }
  const selected: EpisodicMatch[] = [];
  for (const candidate of scored) {
    if (selected.length >= topK) {
      break;
    }
    const candVec = narrativeVecs.get(candidate.sessionId);
    let maxSim = 0;
    if (candVec) {
      for (const sel of selected) {
        const selVec = narrativeVecs.get(sel.sessionId);
        if (selVec) {
          const sim = cosineSimilarity(candVec, selVec);
          if (sim > maxSim) {
            maxSim = sim;
          }
        }
      }
    }
    const penalty = inhibitionStrength * maxSim;
    const inhibited = (candidate.similarity ?? 0) - penalty;
    if (inhibited >= minScore) {
      selected.push(candidate);
    }
  }
  return selected;
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
      scored.push({
        createdAtIso,
        narrative: summary.narrative,
        sessionId: summary.sessionId,
        similarity: (baseSim + recencyBoost) * fadePenalty
      });
    }
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    const consolidated = consolidateNearDuplicates(scored, narrativeVecs);
    const adaptiveK = selectByClusterTransition(consolidated.map((m) => m.similarity ?? 0), { topK: this.topK });
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
