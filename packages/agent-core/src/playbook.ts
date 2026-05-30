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
 * How much one unit of reward shifts the ranking score, as a fraction of a
 * single token-overlap point. Tuned so reward breaks ties and retires a
 * repeatedly-corrected strategy (reward → negative drops it below relevant
 * peers and out of the top-K), without ever overpowering a strong topical
 * match (a 4-token relevance hit still beats a fully-decayed −5 reward).
 */
const REWARD_RANK_WEIGHT = 0.5;

/** Coerce a possibly-absent/garbage reward to the clamped numeric range; absent → 0. */
export function clampReward(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, value));
}

function scoreStrategy(strategy: PlaybookStrategy, query: ReadonlySet<string>): number {
  const relevance = query.size === 0
    ? 0
    : rankOverlap(query, rankTokens(strategy.text)) + 2 * (strategy.tag ? rankOverlap(query, rankTokens(strategy.tag)) : 0);
  return relevance + REWARD_RANK_WEIGHT * clampReward(strategy.reward);
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

export function rankPlaybookStrategies(
  strategies: readonly PlaybookStrategy[],
  queryText: string,
  options?: RankPlaybookOptions
): readonly PlaybookStrategy[] {
  const topK = Math.max(1, Math.trunc(finiteOr(options?.topK, DEFAULT_RANK_TOPK)));
  const minScore = finiteOr(options?.minScore, 0);
  const query = rankTokens(queryText);
  // Input is oldest→newest insertion order, so `index` doubles as a recency
  // proxy (higher = more recent) for the floor below.
  const scored = strategies.map((strategy, index) => ({
    index,
    score: scoreStrategy(strategy, query),
    strategy
  }));

  if (strategies.length <= topK) {
    return [...scored].sort(byScoreDescThenIndexAsc).map((s) => s.strategy);
  }

  const selected = scored.filter((s) => s.score > minScore).sort(byScoreDescThenIndexAsc).slice(0, topK);
  if (selected.length < topK) {
    // Recency floor: a non-empty bank must never inject zero strategies, so
    // top up with the most-recent strategies that didn't clear minScore.
    const chosen = new Set(selected.map((s) => s.index));
    const recentFirst = scored.filter((s) => !chosen.has(s.index)).sort((a, b) => b.index - a.index);
    for (const candidate of recentFirst) {
      if (selected.length >= topK) {
        break;
      }
      selected.push(candidate);
    }
  }
  return [...selected].sort(byScoreDescThenIndexAsc).map((s) => s.strategy);
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
  const ranked = rankPlaybookStrategies(strategies, latestUserText(context.input.messages));
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
