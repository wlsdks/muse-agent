import { appendSystemSection, metadataString } from "./runtime-helpers.js";
import type { AgentRunContext, AgentRunInput, Awaitable } from "./types.js";

/**
 * ACE — Agentic Context Engineering (arXiv 2510.04618): a frozen model
 * self-improves by accumulating small, incremental strategy deltas in an
 * evolving "playbook" instead of being re-prompted/fine-tuned. This is the
 * POSITIVE counterpart to veto-avoidance: where a veto says "don't do X", a
 * playbook strategy says "when X, prefer Y" — a learned how-to the user (or a
 * correction) taught, injected so the agent applies it on matching turns.
 *
 * Duck-typed so `agent-core` stays free of a `@muse/mcp` dependency.
 */
export interface PlaybookStrategy {
  /** The learned strategy, e.g. "when rescheduling, default to the next business day". */
  readonly text: string;
  /** Optional task-class tag so strategies can be scoped/filtered later. */
  readonly tag?: string;
  /**
   * Learned reward — the net outcome signal (reinforcements − decays),
   * clamped to [PLAYBOOK_REWARD_MIN, PLAYBOOK_REWARD_MAX]. 0 = neutral / new.
   * Reward shapes selection (RL over the bank): a proven strategy surfaces
   * first, and one that keeps getting corrected sinks out of the injected
   * top-K. Absent = 0, so a strategy with no recorded outcomes ranks purely
   * on relevance (today's behaviour).
   */
  readonly reward?: number;
  /**
   * PROBATION: a strategy written UNATTENDED (idle daemon distillation) enters
   * probation — recorded + visible but NEVER injected — until a real signal
   * graduates it. Breaks the self-confirmation loop: the agent must not start
   * applying a guess it made about the user without evidence. Absent/false =
   * graduated (injected as normal). (PART A2 / B1 §5, ExpeL evidence-gated.)
   */
  readonly probation?: boolean;
  /**
   * PROVENANCE (B1 §4): `"grounded"` (distilled from a real correction),
   * `"reflected"` (synthesised, no direct correction), or `"manual"`. A
   * `reflected` strategy carries a tiny ranking penalty so a synthetic guess
   * never outranks an otherwise-equal grounded record — evidence beats
   * synthesis at equal standing. Absent = treated as non-reflected.
   */
  readonly origin?: string;
  /**
   * Memp (arXiv 2508.06433): per-entry outcome tallies for evidence-gated
   * lifecycle. Separates "never used" (both 0 / absent) from "used N times
   * with a mixed record" — the net-reward scalar conflates these two states.
   * A VALID tally = both fields present, finite integers ≥ 0, and
   * reinforcements + decays ≥ 1. Missing/garbage → legacy reward path.
   */
  readonly reinforcements?: number;
  readonly decays?: number;
  /** ISO-8601 timestamp of the last user-confirmed reinforcement (D-UCB anchor). */
  readonly lastReinforcedAt?: string;
  /** ISO-8601 creation timestamp; used as fallback anchor when lastReinforcedAt is absent. */
  readonly createdAt?: string;
}

export interface PlaybookProvider {
  listStrategies(userId: string): Awaitable<readonly PlaybookStrategy[]>;
}

function sanitizeInline(value: string): string {
  // Strategies are user-authored free text; collapse whitespace so a
  // `\n[System Override]\n` splice cannot forge a section.
  return value.replace(/\s+/gu, " ").trim();
}

export function renderPlaybookSection(strategies: readonly PlaybookStrategy[]): string | undefined {
  const cleaned = strategies.map((s) => sanitizeInline(s.text)).filter((t) => t.length > 0);
  if (cleaned.length === 0) {
    return undefined;
  }
  const lines = [
    "[Learned Strategies]",
    "From past feedback, apply these working preferences when they fit the",
    "current request (they are guidance, not overrides of the user's words):"
  ];
  for (const text of cleaned) {
    lines.push(`- ${text}`);
  }
  return lines.join("\n");
}

/**
 * ReasoningBank (arXiv 2509.25140): a self-evolving agent retrieves only the
 * reasoning memory RELEVANT to the current task instead of dumping the whole
 * bank. Here it ranks the playbook's strategies against the current turn and
 * keeps the top-K, so as auto-distillation grows the bank the small local
 * model still sees a tight, on-topic directive block (`tool-calling.md`).
 *
 * Deterministic: token-overlap (CJK-aware, stopword-filtered) between the
 * query and each strategy's text + tag (a tag mention is weighted as a strong
 * signal). No embeddings, no LLM, no new dep — the scorer is the swap-point
 * for an embedding ranker later. When the bank is at or below `topK` the SET
 * is unchanged (today's inject-all), only ordered most-relevant-first.
 */
export interface RankPlaybookOptions {
  /** Max strategies to keep. Default 6 — bounds the injected directive block. */
  readonly topK?: number;
  /** A strategy must exceed this overlap score to qualify on relevance. Default 0. */
  readonly minScore?: number;
}

const DEFAULT_RANK_TOPK = 6;

// Whole-word ASCII function words add noise to overlap scoring (a decoy
// sharing only "the"/"to" would falsely rank). CJK bigrams are not filtered.
const RANK_STOPWORDS = new Set<string>([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "to", "of",
  "in", "on", "for", "and", "or", "my", "your", "our", "what", "who", "how",
  "do", "does", "did", "you", "it", "its", "this", "that", "with", "at", "by",
  "as", "me", "we", "i", "if", "so", "no", "not", "from", "about", "into",
  "than", "please", "the"
]);

// Hangul / Han / Kana are word chars; everything else splits. Mirrors the
// CJK-aware tokenisation episodic-recall uses so Korean strategies match.
const RANK_NON_WORD_RE = /[^a-z0-9가-힯一-鿿぀-ゟ゠-ヿ]+/u;
const RANK_CJK_RE = /[가-힯一-鿿぀-ゟ゠-ヿ]/u;

function rankTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().split(RANK_NON_WORD_RE)) {
    if (raw.length < 2) {
      continue;
    }
    if (RANK_CJK_RE.test(raw)) {
      // CJK has no word spaces; emit char bigrams so a paraphrase still
      // overlaps ("이메일은" shares "이메"/"메일" with "이메일").
      for (let index = 0; index < raw.length - 1; index += 1) {
        tokens.add(raw.slice(index, index + 2));
      }
    } else if (!RANK_STOPWORDS.has(raw)) {
      tokens.add(raw);
    }
  }
  return tokens;
}

function rankOverlap(query: ReadonlySet<string>, tokens: ReadonlySet<string>): number {
  let shared = 0;
  for (const token of tokens) {
    if (query.has(token)) {
      shared += 1;
    }
  }
  return shared;
}

/**
 * Token-overlap (Jaccard) similarity between two strategy texts, CJK-aware via
 * the same tokeniser. Used to dedupe an auto-distilled strategy against the
 * existing bank so repeated corrections don't fill the playbook with
 * paraphrases of one lesson (ReasoningBank, arXiv 2509.25140).
 */
export function strategyTextSimilarity(a: string, b: string): number {
  const ta = rankTokens(a);
  const tb = rankTokens(b);
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (ta.size + tb.size - intersection);
}

/** Reward bounds — net outcome signal per strategy, clamped so one streak can't dominate ranking. */
export const PLAYBOOK_REWARD_MIN = -5;
export const PLAYBOOK_REWARD_MAX = 5;
/**
 * Discounted-UCB half-life (arXiv:0805.3415, Garivier & Moulines 2008): user
 * preferences drift, so a reinforcement from 30 days ago carries half the
 * weight of one from today. Aligns with PLAYBOOK_DECAY_STALE_DAYS.
 */
export const PLAYBOOK_RECENCY_HALF_LIFE_DAYS = 30;
/**
 * How much one unit of reward shifts the ranking score, as a fraction of a
 * single token-overlap point. Tuned so reward breaks ties and retires a
 * repeatedly-corrected strategy (reward → negative drops it below relevant
 * peers and out of the top-K), without ever overpowering a strong topical
 * match (a 4-token relevance hit still beats a fully-decayed −5 reward).
 */
const REWARD_RANK_WEIGHT = 0.5;

/**
 * Tie-break penalty for a `reflected` (synthetic) strategy, B1 §4. Far smaller
 * than one reward step (0.5) or one relevance point (1), so it ONLY decides a
 * dead heat: a synthetic reflection never outranks an otherwise-equal grounded
 * record, but a genuinely more-relevant/higher-reward strategy still wins.
 */
const REFLECTED_RANK_PENALTY = 0.01;

/** Coerce a possibly-absent/garbage reward to the clamped numeric range; absent → 0. */
export function clampReward(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, value));
}

/**
 * Discounted-UCB recency multiplier (arXiv:0805.3415, Garivier & Moulines 2008).
 * User preferences are non-stationary: a reinforcement from the recent past
 * deserves more weight than one from months ago. Returns a multiplier in (0,1].
 *
 * Anchor = lastReinforcedAt ?? createdAt. When absent or unparseable → 1
 * (legacy-identical, no discount applied). Future anchors are treated as age 0
 * (multiplier 1) — a positive boost is never applied.
 */
export function recencyDiscount(
  strategy: PlaybookStrategy,
  nowMs: number,
  halfLifeDays = PLAYBOOK_RECENCY_HALF_LIFE_DAYS
): number {
  const anchorMs = Date.parse(strategy.lastReinforcedAt ?? strategy.createdAt ?? "");
  if (isNaN(anchorMs)) {
    return 1;
  }
  const ageDays = Math.max(0, (nowMs - anchorMs) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Standard Wilson score interval — the Memp (arXiv 2508.06433) confidence
 * gate so lifecycle decisions require sufficient evidence, not a single event.
 * z=1.96 ≈ 95% confidence by default.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96
): { lower: number; upper: number } {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || !Number.isFinite(z) || total <= 0) {
    return { lower: 0, upper: 1 };
  }
  const pHat = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (pHat + z2 / (2 * total)) / denom;
  const margin = (z / denom) * Math.sqrt(pHat * (1 - pHat) / total + z2 / (4 * total * total));
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) };
}

function hasValidTally(s: PlaybookStrategy): boolean {
  const r = s.reinforcements;
  const d = s.decays;
  return (
    typeof r === "number" && Number.isFinite(r) && r >= 0 && Number.isInteger(r) &&
    typeof d === "number" && Number.isFinite(d) && d >= 0 && Number.isInteger(d) &&
    r + d >= 1
  );
}

/**
 * Evidence-damped reward: when a valid tally exists (Memp, arXiv 2508.06433)
 * derive the effective score from outcome tallies with a shrinkage factor so a
 * single trial stays near neutral. Falls back to the legacy clamped reward for
 * entries without a valid tally — byte-identical to the pre-change path.
 *
 * When `nowMs` is provided and a parseable timestamp anchor exists on the
 * strategy, the POSITIVE reward component is multiplied by a recency discount
 * (D-UCB, arXiv:0805.3415) so stale trust fades. The negative/sunk component
 * is never discounted — recency fades trust, it never un-sinks a corrected
 * strategy (INV-2). When `nowMs` is absent the result is byte-identical to the
 * pre-change value (INV-1).
 */
export function effectiveStrategyReward(s: PlaybookStrategy, nowMs?: number): number {
  if (!hasValidTally(s)) {
    const base = clampReward(s.reward);
    if (nowMs !== undefined && base > 0) {
      return base * recencyDiscount(s, nowMs);
    }
    return base;
  }
  const r = s.reinforcements as number;
  const d = s.decays as number;
  const n = r + d;
  const pHat = r / n;
  // Shrinkage: n/(n+3) pulls sparse evidence toward neutral (0.5)
  const raw = Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, (2 * pHat - 1) * PLAYBOOK_REWARD_MAX * (n / (n + 3))));
  if (nowMs !== undefined && raw > 0) {
    return raw * recencyDiscount(s, nowMs);
  }
  return raw;
}

/** Lifecycle action from Memp (arXiv 2508.06433): deprecate a confidently-bad entry, graduate a confidently-good probation entry, retain otherwise. */
export type StrategyLifecycleAction = "retain" | "deprecate" | "graduate";

export function planStrategyLifecycle(
  s: PlaybookStrategy,
  _opts?: Record<string, unknown>
): StrategyLifecycleAction {
  if (!hasValidTally(s)) {
    return "retain";
  }
  const r = s.reinforcements as number;
  const d = s.decays as number;
  const n = r + d;
  const { lower, upper } = wilsonInterval(r, n);
  if (upper < 0.4 && n >= 5) {
    return "deprecate";
  }
  if (s.probation === true && lower > 0.5 && n >= 3) {
    return "graduate";
  }
  return "retain";
}

/**
 * Learned avoidance: a strategy whose reward has sunk to or below this is
 * EXCLUDED from injection entirely (not merely deranked) — even in a small bank
 * where ranking would otherwise return everything. The soft, reversible
 * counterpart to the veto store: a strategy corrected this many times stops
 * being applied, but stays in the bank (visible, and an approval can lift it
 * back above the line).
 */
export const PLAYBOOK_AVOID_BELOW = -4;

/**
 * True when a strategy is avoided (never injected). Checks the legacy
 * reward floor OR a Memp-evidence-gated deprecation (arXiv 2508.06433)
 * so a confidently-bad entry is excluded even if its net reward hasn't
 * crossed the floor yet.
 */
export function isAvoidedStrategy(strategy: PlaybookStrategy): boolean {
  return clampReward(strategy.reward) <= PLAYBOOK_AVOID_BELOW || planStrategyLifecycle(strategy) === "deprecate";
}

/**
 * A strategy is injectable when it is neither avoided (reward floor / evidence
 * deprecation) nor on probation without sufficient good evidence to graduate.
 * Memp (arXiv 2508.06433): a probation entry whose lifecycle action is
 * "graduate" becomes injectable; one with insufficient evidence stays guarded.
 */
export function isInjectableStrategy(strategy: PlaybookStrategy): boolean {
  if (isAvoidedStrategy(strategy)) {
    return false;
  }
  if (strategy.probation !== true) {
    return true;
  }
  // Evidence-gated graduation: probation clears only when Memp says graduate
  return planStrategyLifecycle(strategy) === "graduate";
}

/**
 * Embedding cosine weight. A semantic match contributes up to this many points
 * — set above the max realistic lexical-overlap so a strategy the user phrased
 * DIFFERENTLY from the current query still surfaces (experience-following:
 * retrieval quality dominates a frozen small model's output), while reward and
 * avoidance still sink a repeatedly-corrected one. Only applied by the
 * embedding ranker; the lexical ranker passes no cosine.
 */
const EMBED_RANK_WEIGHT = 5;

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * MemRL (arXiv:2601.03192): λ=0.5 is the paper's empirical optimum for the
 * value-aware composite score combining z-normalised relevance and utility.
 */
const MEMRL_VALUE_WEIGHT = 0.5;

function relevanceScore(strategy: PlaybookStrategy, query: ReadonlySet<string>, cosine?: number): number {
  const lexical = query.size === 0
    ? 0
    : rankOverlap(query, rankTokens(strategy.text)) + 2 * (strategy.tag ? rankOverlap(query, rankTokens(strategy.tag)) : 0);
  const semantic = typeof cosine === "number" && Number.isFinite(cosine) ? EMBED_RANK_WEIGHT * cosine : 0;
  return lexical + semantic;
}

/** z-score normalise an array; σ=0 contributes 0 for all entries (composite degrades to the other component). */
function zScoreNorm(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) {
    return [];
  }
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sigma = Math.sqrt(variance);
  if (sigma === 0) {
    return values.map(() => 0);
  }
  return values.map((v) => (v - mean) / sigma);
}

function byScoreDescThenIndexAsc(
  a: { readonly score: number; readonly index: number },
  b: { readonly score: number; readonly index: number }
): number {
  return b.score - a.score || a.index - b.index;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * MMR (Maximal Marginal Relevance) diversity-aware final cut — arXiv:2502.09017
 * (Wang et al. 2025, "Diversity Enhances an LLM's Performance in RAG and Long-context Task").
 * Greedy selection: each iteration picks the candidate maximising
 *   λ·normScore − (1−λ)·maxJaccard(candidate, alreadyPicked)
 * where normScore is min-max normalised to [0,1] so λ blends against the [0,1]
 * Jaccard similarity on the same scale.
 * λ=0.7 keeps the cut relevance-dominant: MMR only breaks near-ties, never
 * drops a clearly-more-relevant strategy in favour of a diverse-but-weaker one.
 * Ties (equal MMR value) are broken by original index (lower = earlier insertion).
 * Note: Jaccard is token-overlap so cross-lingual duplicates (KO+EN paraphrase
 * of the same lesson) score ~0 similarity — they are treated as distinct and
 * both can be selected. This is the safe direction (a missed dup = status quo).
 */
const MMR_DIVERSITY_LAMBDA = 0.7;

/**
 * Jaccard threshold above which two strategies are considered same-language paraphrases.
 * High (0.8) so only genuine same-language paraphrases collapse; cross-lingual pairs
 * (KO + EN) score ~0 → never collapsed, safe direction (missed dup = status quo).
 * Extends the shipped MMR diversity principle (arXiv:2502.09017) to the small-bank path;
 * grounded in budget-matched diversity (arXiv:2510.17940, Lin 2025).
 */
export const PLAYBOOK_INJECT_DEDUP_THRESHOLD = 0.8;

type ScoredEntry = { readonly score: number; readonly index: number; readonly strategy: PlaybookStrategy };

/**
 * Greedy near-duplicate suppression over a composite-descending scored list.
 * Admits an entry only if its Jaccard similarity to every already-admitted entry is
 * below `threshold`; otherwise drops the lower-composite duplicate.
 * Pure, order-preserving, never throws. Safe direction: cross-lingual pairs (Jaccard ~0)
 * are always kept — a missed dup is status quo, a dropped distinct strategy is not.
 */
export function suppressNearDuplicateStrategies(
  scored: readonly ScoredEntry[],
  threshold = PLAYBOOK_INJECT_DEDUP_THRESHOLD
): ScoredEntry[] {
  const admitted: ScoredEntry[] = [];
  for (const entry of scored) {
    const isDup = admitted.some(
      (a) => strategyTextSimilarity(entry.strategy.text, a.strategy.text) >= threshold
    );
    if (!isDup) {
      admitted.push(entry);
    }
  }
  return admitted;
}

function mmrSelectStrategies(scored: readonly ScoredEntry[], k: number): ScoredEntry[] {
  if (scored.length === 0 || k <= 0) {
    return [];
  }
  const scores = scored.map((e) => e.score);
  const minS = Math.min(...scores);
  const maxS = Math.max(...scores);
  const range = maxS - minS;
  // When all scores are equal, normScore = 1 for all → relevance tied, diversity decides.
  const normScore = (s: number): number => (range === 0 ? 1 : (s - minS) / range);

  const remaining = [...scored];
  const picked: ScoredEntry[] = [];

  while (picked.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const maxSim = picked.length === 0
        ? 0
        : Math.max(...picked.map((p) => strategyTextSimilarity(candidate.strategy.text, p.strategy.text)));
      const mmr = MMR_DIVERSITY_LAMBDA * normScore(candidate.score) - (1 - MMR_DIVERSITY_LAMBDA) * maxSim;
      if (mmr > bestMmr || (mmr === bestMmr && candidate.index < remaining[bestIdx]!.index)) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    picked.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }
  return picked;
}

function rankEligible(
  strategies: readonly PlaybookStrategy[],
  options: RankPlaybookOptions | undefined,
  relevanceOf: (strategy: PlaybookStrategy) => number,
  utilityOf: (strategy: PlaybookStrategy) => number
): readonly PlaybookStrategy[] {
  const topK = Math.max(1, Math.trunc(finiteOr(options?.topK, DEFAULT_RANK_TOPK)));
  const minScore = finiteOr(options?.minScore, 0);
  // Learned avoidance and probation exclusion run before ranking.
  const eligible = strategies.filter(isInjectableStrategy);
  // Input is oldest→newest insertion order, so `index` doubles as a recency
  // proxy (higher = more recent) for the floor below.
  const withRel = eligible.map((strategy, index) => ({
    index,
    relevance: relevanceOf(strategy),
    strategy
  }));

  if (eligible.length <= topK) {
    // Small-bank path: inject all, ordered by composite (relevance + reward − penalty).
    const scored = withRel.map((e) => ({
      ...e,
      score: e.relevance + REWARD_RANK_WEIGHT * utilityOf(e.strategy)
        - (e.strategy.origin === "reflected" ? REFLECTED_RANK_PENALTY : 0)
    }));
    const sorted = [...scored].sort(byScoreDescThenIndexAsc);
    // Suppress near-duplicate paraphrases; keeps the higher-composite entry (sorted first).
    return suppressNearDuplicateStrategies(sorted).map((s) => s.strategy);
  }

  // MemRL two-phase value-aware retrieval (arXiv:2601.03192):
  // Phase A — relevance gates eligibility. Reward can never lift an off-topic strategy in.
  const k1 = 2 * topK;
  const candidates = withRel
    .filter((e) => e.relevance > minScore)
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
    .slice(0, k1);

  if (candidates.length === 0) {
    // Recency floor: non-empty bank must never inject zero strategies.
    const recentFirst = withRel.slice().sort((a, b) => b.index - a.index);
    const floor: typeof withRel = [];
    for (const candidate of recentFirst) {
      if (floor.length >= topK) {
        break;
      }
      floor.push(candidate);
    }
    const scored = floor.map((e) => ({
      ...e,
      score: e.relevance + REWARD_RANK_WEIGHT * utilityOf(e.strategy)
        - (e.strategy.origin === "reflected" ? REFLECTED_RANK_PENALTY : 0)
    }));
    return [...scored].sort(byScoreDescThenIndexAsc).map((s) => s.strategy);
  }

  // Phase B — within the candidate pool, z-score normalise relevance and utility,
  // then pick top-K by composite. λ=0.5 per MEMRL_VALUE_WEIGHT.
  const relValues = candidates.map((e) => e.relevance);
  const utilValues = candidates.map((e) => utilityOf(e.strategy));
  const relNorm = zScoreNorm(relValues);
  const utilNorm = zScoreNorm(utilValues);

  const phaseB = candidates.map((e, i) => ({
    ...e,
    score: MEMRL_VALUE_WEIGHT * (relNorm[i] ?? 0) + MEMRL_VALUE_WEIGHT * (utilNorm[i] ?? 0)
      - (e.strategy.origin === "reflected" ? REFLECTED_RANK_PENALTY : 0)
  }));

  const selected = mmrSelectStrategies(phaseB.sort(byScoreDescThenIndexAsc), topK);

  if (selected.length < topK) {
    // Recency floor: top up with most-recent strategies not already selected.
    const chosen = new Set(selected.map((s) => s.index));
    const recentFirst = withRel
      .filter((e) => !chosen.has(e.index))
      .sort((a, b) => b.index - a.index);
    for (const candidate of recentFirst) {
      if (selected.length >= topK) {
        break;
      }
      selected.push({
        ...candidate,
        score: candidate.relevance + REWARD_RANK_WEIGHT * utilityOf(candidate.strategy)
          - (candidate.strategy.origin === "reflected" ? REFLECTED_RANK_PENALTY : 0)
      });
    }
  }

  return [...selected].sort(byScoreDescThenIndexAsc).map((s) => s.strategy);
}

export function rankPlaybookStrategies(
  strategies: readonly PlaybookStrategy[],
  queryText: string,
  options?: RankPlaybookOptions,
  nowMs?: number
): readonly PlaybookStrategy[] {
  const query = rankTokens(queryText);
  return rankEligible(strategies, options, (s) => relevanceScore(s, query), (s) => effectiveStrategyReward(s, nowMs));
}

/**
 * Embedding-ranked variant of `rankPlaybookStrategies`: blends cosine(query,
 * strategy) into the score so a strategy the user phrased DIFFERENTLY from the
 * current query still surfaces — lexical token-overlap misses a paraphrase, but
 * meaning doesn't. `embed` is duck-typed (text → vector) so agent-core stays
 * model-agnostic; the caller passes a local embedder. Only eligible
 * (non-avoided, non-probation) strategies are embedded, and any strategy whose
 * embedding fails falls back to its pure-lexical score — so a flaky embedder
 * degrades gracefully rather than dropping a strategy. Same top-K + recency
 * floor + exclusions as the sync ranker.
 */
export async function rankPlaybookStrategiesByRelevance(
  strategies: readonly PlaybookStrategy[],
  queryText: string,
  embed: (text: string) => Promise<readonly number[]>,
  options?: RankPlaybookOptions,
  nowMs?: number
): Promise<readonly PlaybookStrategy[]> {
  const query = rankTokens(queryText);
  let queryVec: readonly number[] | undefined;
  try {
    queryVec = await embed(queryText);
  } catch {
    queryVec = undefined;
  }
  const cosineByText = new Map<string, number>();
  if (queryVec && queryVec.length > 0) {
    for (const strategy of strategies.filter(isInjectableStrategy)) {
      if (cosineByText.has(strategy.text)) {
        continue;
      }
      try {
        cosineByText.set(strategy.text, cosineSimilarity(queryVec, await embed(strategy.text)));
      } catch {
        // leave unset → this strategy is scored on lexical overlap + reward only
      }
    }
  }
  return rankEligible(strategies, options, (s) => relevanceScore(s, query, cosineByText.get(s.text)), (s) => effectiveStrategyReward(s, nowMs));
}

function latestUserText(messages: readonly { readonly role: string; readonly content: string }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/**
 * Inject the user's learned strategies as a `[Learned Strategies]` system
 * block so the agent applies what past corrections taught (ACE's evolving
 * playbook). Conservative + opt-out-safe: no provider, no `metadata.userId`,
 * or zero strategies ⇒ input returned unchanged (smoke:live unaffected).
 * Fail-open: a throwing provider degrades to no-op.
 */
export async function applyPlaybook(
  context: AgentRunContext,
  provider: PlaybookProvider | undefined
): Promise<AgentRunInput> {
  if (!provider) {
    return context.input;
  }
  const userId = metadataString(context.input.metadata, "userId");
  if (!userId) {
    return context.input;
  }
  let strategies: readonly PlaybookStrategy[];
  try {
    strategies = await provider.listStrategies(userId);
  } catch {
    return context.input;
  }
  // ReasoningBank (arXiv 2509.25140): inject only the strategies relevant to
  // this turn, ranked by the latest user message — not the whole bank.
  // D-UCB (arXiv:0805.3415): pass nowMs so stale reinforcements fade.
  const ranked = rankPlaybookStrategies(strategies, latestUserText(context.input.messages), undefined, Date.now());
  const rendered = renderPlaybookSection(ranked);
  if (!rendered) {
    return context.input;
  }
  return {
    ...context.input,
    messages: appendSystemSection(context.input.messages, rendered, "playbook"),
    metadata: { ...context.input.metadata, playbookApplied: true }
  };
}
