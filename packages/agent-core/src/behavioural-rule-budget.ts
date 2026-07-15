/**
 * Behavioural rule budget — the shared cap across playbook / veto / preference
 * / goal rules that all land in the SAME system-prompt slot competing for the
 * same model attention. MOSAIC (arXiv 2601.18554) / IFScale (arXiv 2507.11538)
 * measured 1-6 simultaneous constraints as reliable, 7-15 "unpredictable", and
 * an 8B model at 17.9% compliance where a 70B holds 76.3% at the same load.
 * Muse's playbook was already capped + MMR-ranked (DEFAULT_RANK_TOPK) — vetoes
 * and goals were not, and a 3-month user already carries 29 simultaneous rules.
 *
 * Three deterministic stages, in order:
 *   1. Relevant-veto guarantee — any veto matching the current turn is
 *      admitted UNCONDITIONALLY, before conflict resolution or the budget cut
 *      can touch it. A veto is the user's explicit refusal; running
 *      suppression or the budget cut first can drop the one veto that
 *      mattered (measured: it silently dropped a life-safety veto to make
 *      room for trivia). This ordering makes the shared budget a STRICTLY
 *      STRONGER guarantee than today's unbounded-but-unranked injection.
 *   2. Conflict resolution among the REST, from STORED conflict edges
 *      (`BehaviouralRule.conflictsWith`) — a deterministic LOOKUP, zero model
 *      calls in the turn. The edges themselves are computed once, at LEARN
 *      time, by an LLM binary classifier (rule-conflict.ts) — embedding
 *      cosine cannot separate a rule conflict from a compatible pair
 *      (measured: contradictory pairs 0.190-0.748, compatible pairs
 *      0.152-0.378 — the ranges overlap and cosine measures TOPIC, not
 *      AGREEMENT).
 *   3. Budget cut, ranked by relevance to the turn — insertion order is not
 *      relevance.
 */

import { strategyTextSimilarity } from "./playbook-ranking.js";

/** Reliable-compliance ceiling from the measured literature (see module docstring). */
export const RULE_BUDGET_DEFAULT = 7;

/**
 * Hard ceiling regardless of env override — closes the "one env var away from
 * injecting 50+" hole (`MUSE_PLAYBOOK_INJECT_TOPK` previously had a floor but
 * no ceiling).
 */
export const RULE_BUDGET_CEILING = 10;

export type BehaviouralRuleKind = "veto" | "pref" | "goal" | "playbook";

/**
 * Composite key naming convention shared by every BehaviouralRule producer and
 * consumer (`muse-persona.ts`'s admission filter, `ask-behavioural-rules.ts`'s
 * rule assembly): `${kind}:${key}` so a plain preference, veto, and goal that
 * happen to share the same stripped key (e.g. "budget") never collide in the
 * admitted-keys set.
 */
export function admittedRuleKey(kind: BehaviouralRuleKind, key: string): string {
  return `${kind}:${key}`;
}

export interface BehaviouralRule {
  readonly kind: BehaviouralRuleKind;
  readonly key: string;
  readonly text: string;
  /** Net learned reward; absent/non-finite reads as neutral (0). */
  readonly reward?: number;
  /** Position in the source array — higher = more recently added. */
  readonly index: number;
  /**
   * Keys of other rules THIS one is known to conflict with, from a learn-time
   * LLM classification persisted on the strategy (rule-conflict.ts). Absent =
   * no known conflicts — the common case, since only the distill path writes
   * this edge and only between playbook strategies today.
   */
  readonly conflictsWith?: readonly string[];
}

/**
 * Resolve the effective budget: `MUSE_RULE_BUDGET` first, then the legacy
 * `MUSE_PLAYBOOK_INJECT_TOPK` (so an existing override still does something),
 * then the default — and CLAMP every path to `RULE_BUDGET_CEILING`. This is
 * the missing clamp: the legacy env var had a floor (>=1) but nothing stopped
 * `MUSE_PLAYBOOK_INJECT_TOPK=100` from injecting 100 rules.
 */
export function ruleBudget(env: NodeJS.ProcessEnv = process.env): number {
  const primary = Number(env.MUSE_RULE_BUDGET);
  if (Number.isFinite(primary) && primary >= 1) {
    return Math.min(RULE_BUDGET_CEILING, Math.trunc(primary));
  }
  const legacy = Number(env.MUSE_PLAYBOOK_INJECT_TOPK);
  if (Number.isFinite(legacy) && legacy >= 1) {
    return Math.min(RULE_BUDGET_CEILING, Math.trunc(legacy));
  }
  return RULE_BUDGET_DEFAULT;
}

/**
 * Whether either the shared budget or the legacy env var was EXPLICITLY set.
 * The playbook prefetch (rankPlaybookStrategies' own topK) must keep its
 * pre-existing default of 6 (DEFAULT_RANK_TOPK in playbook-ranking.ts) when
 * nothing is overridden — a prior attempt silently raised it to `ruleBudget()`
 * (7) by threading the shared-budget value in unconditionally.
 */
function hasExplicitBudgetOverride(env: NodeJS.ProcessEnv): boolean {
  return env.MUSE_RULE_BUDGET !== undefined || env.MUSE_PLAYBOOK_INJECT_TOPK !== undefined;
}

/**
 * The topK to hand the playbook's OWN pre-ranking (rankPlaybookStrategies /
 * rankPlaybookStrategiesByRelevance) before its candidates ever reach the
 * shared behavioural-rule budget below. `undefined` when no override is set,
 * so the playbook ranker's internal default (6) applies unchanged; the
 * clamped `ruleBudget()` value only when the user actually set an override.
 */
export function playbookPrefetchTopK(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return hasExplicitBudgetOverride(env) ? ruleBudget(env) : undefined;
}

/** Contradiction-resolution priority — a veto beats a preference beats a goal beats a bare playbook strategy. */
const KIND_PRIORITY: Readonly<Record<BehaviouralRuleKind, number>> = { goal: 1, playbook: 0, pref: 2, veto: 3 };

/** Composite-score kind weight (spec: veto 0.5, pref 0.1, goal 0, playbook 0). */
const KIND_RELEVANCE_WEIGHT: Readonly<Record<BehaviouralRuleKind, number>> = { goal: 0, playbook: 0, pref: 0.1, veto: 0.5 };

/**
 * Reward's contribution to the ranking composite, as a fraction of one
 * relevance point — mirrors `REWARD_RANK_WEIGHT` in playbook-ranking.ts so
 * reward breaks ties without ever overpowering a real topical match.
 */
const REWARD_RANK_WEIGHT = 0.5;

function effectiveReward(rule: BehaviouralRule): number {
  return typeof rule.reward === "number" && Number.isFinite(rule.reward) ? rule.reward : 0;
}

/**
 * Which of two conflicting rules to KEEP. Priority: veto > pref > goal >
 * playbook, then higher reward, then more recent index — Muse's forget-on-
 * correction identity: a newer correction supersedes an older rule.
 */
function higherPriority(a: BehaviouralRule, b: BehaviouralRule): BehaviouralRule {
  if (KIND_PRIORITY[a.kind] !== KIND_PRIORITY[b.kind]) {
    return KIND_PRIORITY[a.kind] > KIND_PRIORITY[b.kind] ? a : b;
  }
  const rewardA = effectiveReward(a);
  const rewardB = effectiveReward(b);
  if (rewardA !== rewardB) {
    return rewardA > rewardB ? a : b;
  }
  return a.index >= b.index ? a : b;
}

export interface SuppressedRule {
  readonly rule: BehaviouralRule;
  readonly reason: string;
  /** The key of the rule that superseded this one. */
  readonly supersededByKey: string;
}

export interface SelectBehaviouralRulesResult {
  readonly admitted: readonly BehaviouralRule[];
  readonly dropped: readonly BehaviouralRule[];
  readonly suppressed: readonly SuppressedRule[];
  /** Whether the input set exceeded the applied budget before any cut. */
  readonly overBudget: boolean;
}

export interface SelectBehaviouralRulesOptions {
  /** Defaults to RULE_BUDGET_DEFAULT; always clamped to RULE_BUDGET_CEILING. */
  readonly budget?: number;
}

/**
 * Select which behavioural rules reach the system prompt this turn. See the
 * module docstring for the three stages. Never throws — every stage
 * degrades gracefully to "make the safe cut" rather than injecting more.
 */
export async function selectBehaviouralRules(
  rules: readonly BehaviouralRule[],
  query: string,
  opts: SelectBehaviouralRulesOptions = {}
): Promise<SelectBehaviouralRulesResult> {
  const budget = opts.budget !== undefined
    ? Math.min(RULE_BUDGET_CEILING, Math.max(1, Math.trunc(opts.budget)))
    : RULE_BUDGET_DEFAULT;
  const overBudget = rules.length > budget;

  const trimmedQuery = query.trim();
  const withRelevance = rules.map((rule) => ({
    relevance: trimmedQuery.length > 0 ? strategyTextSimilarity(trimmedQuery, rule.text) : 0,
    rule
  }));

  // Stage 1 — the veto guarantee. EVERY veto is admitted, exempt from conflict
  // suppression, and outside the budget entirely.
  //
  // This was first written as "every veto whose relevance to the turn is > 0",
  // and that version silently dropped the veto that mattered most. Measured: for
  // the query "what should I eat for lunch?", the veto "never suggest anything
  // containing peanuts — anaphylaxis" scores relevance 0.000 — it shares not one
  // token with the question. So the guarantee never fired, the veto fell through
  // to the ranked cut, and eight ordinary playbook strategies outranked it.
  //
  // A relevance gate on a safety list cannot work, and not because this
  // similarity function is weak. A peanut allergy IS relevant to lunch; nothing
  // lexical can see that, and embedding cosine cannot either — it measures topic,
  // not implication (measured: contradictory rule pairs score 0.190–0.748,
  // compatible ones 0.152–0.378; the ranges overlap). There is no cheap signal
  // that tells a life-threatening veto from a trivial one for a given turn.
  //
  // So we do not try. A veto is the user's explicit refusal; it is rare, it is
  // short, and dropping the wrong one re-enables something they said never to do.
  // An over-long veto list costs tokens. A missed veto costs trust, and possibly
  // more. The budget governs preferences, goals and strategies — never vetoes.
  const guaranteed = withRelevance.filter((r) => r.rule.kind === "veto");
  const guaranteedKeys = new Set(guaranteed.map((r) => r.rule.key));
  const rest = withRelevance.filter((r) => !guaranteedKeys.has(r.rule.key));

  // Stage 2 — conflict resolution among the rest, from stored edges only (no
  // model call, no cosine gate). Each stored edge is resolved once; the
  // higher-priority/higher-reward/more-recent rule survives.
  const restByKey = new Map(rest.map((r) => [r.rule.key, r]));
  const suppressed: SuppressedRule[] = [];
  const suppressedKeys = new Set<string>();
  const seenPairs = new Set<string>();
  // A veto is exempt from LOSING a conflict, but it must still WIN one. A learned
  // strategy that contradicts something the user forbade is the strategy that goes
  // — otherwise both reach the prompt and, per ConInstruct, the model silently
  // obeys one with no signal which. Conflict edges are also ASYMMETRIC: the pair
  // is recorded on whichever rule was learned second, so a veto's edge must be
  // walked from the veto's side too, and a strategy's edge naming a veto from the
  // strategy's side. Both directions, one outcome: the veto wins.
  const vetoBeats = (loserKey: string, vetoKey: string): void => {
    const loser = restByKey.get(loserKey)?.rule;
    if (!loser || suppressedKeys.has(loserKey)) {
      return;
    }
    suppressedKeys.add(loserKey);
    suppressed.push({ reason: "contradicts a veto you set", rule: loser, supersededByKey: vetoKey });
  };
  for (const { rule } of guaranteed) {
    for (const otherKey of rule.conflictsWith ?? []) {
      vetoBeats(otherKey, rule.key);
    }
  }
  for (const { rule } of rest) {
    for (const otherKey of rule.conflictsWith ?? []) {
      if (guaranteedKeys.has(otherKey)) {
        vetoBeats(rule.key, otherKey);
        continue;
      }
      const other = restByKey.get(otherKey)?.rule;
      if (!other) {
        continue; // the conflicting rule isn't part of this turn's candidate set
      }
      const pairKey = rule.key < otherKey ? `${rule.key}\u0000${otherKey}` : `${otherKey}\u0000${rule.key}`;
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);
      const winner = higherPriority(rule, other);
      const loser = winner === rule ? other : rule;
      if (suppressedKeys.has(loser.key)) {
        continue;
      }
      suppressedKeys.add(loser.key);
      suppressed.push({ reason: `contradicts "${winner.text}"`, rule: loser, supersededByKey: winner.key });
    }
  }
  const survivors = rest.filter((r) => !suppressedKeys.has(r.rule.key));

  // Stage 3 — budget cut, ranked by relevance to the turn.
  const scored = survivors.map(({ relevance, rule }) => ({
    relevance,
    rule,
    score: relevance + KIND_RELEVANCE_WEIGHT[rule.kind] + REWARD_RANK_WEIGHT * effectiveReward(rule)
  }));
  const ranked = [...scored].sort((a, b) => b.score - a.score || b.rule.index - a.rule.index);
  // Vetoes sit OUTSIDE the budget, so they do not spend its slots. Subtracting
  // them would mean a user with many vetoes gets no learned strategies at all —
  // trading one silent loss for another. The budget is what bounds the rules Muse
  // CHOSE to learn; a veto is a rule the user IMPOSED, and it is not negotiable
  // against a preference.
  const admittedRest = ranked.slice(0, budget);
  const droppedRest = ranked.slice(budget);

  const admitted = [...guaranteed.map((g) => ({ ...g, score: Number.POSITIVE_INFINITY })), ...admittedRest]
    .sort((a, b) => b.score - a.score || b.rule.index - a.rule.index)
    .map((s) => s.rule);

  return { admitted, dropped: droppedRest.map((s) => s.rule), overBudget, suppressed };
}
