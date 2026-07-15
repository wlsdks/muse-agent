/**
 * ReasoningBank slice 2 (arXiv 2509.25140) + the RL reward loop (P33):
 * end-of-session learning. Reads the just-finished session and runs both
 * feedback signals against the SAME `~/.muse/playbook.json` the
 * [Learned Strategies] injection reads:
 *   - a user CORRECTION → distil one generalised strategy (ReasoningBank) AND
 *     DECAY the strategy the correction implicated (reward −1);
 *   - a user APPROVAL → REINFORCE the strategy that applied (reward +1).
 * So the bank doesn't just grow, it self-reinforces toward what works.
 *
 * Mirrors `captureEndOfSessionEpisode`: I/O is injectable, every step is
 * fail-soft, and it returns a typed skip reason rather than throwing. The env
 * gate (`MUSE_PLAYBOOK_DISTILL_ENABLED`) is checked by the REPL-exit caller so
 * the manual `muse playbook distill` command can run regardless.
 */

import { randomUUID } from "node:crypto";

import {
  DEFAULT_PLAYBOOK_CREDIT_COSINE,
  DEFAULT_PLAYBOOK_DECAY_CREDIT_COSINE,
  PLAYBOOK_CREDIT_MARGIN,
  PLAYBOOK_DECAY_CREDIT_MARGIN,
  detectApprovals,
  detectCorrections,
  distillConsistentStrategy,
  distillStrategyFromCorrection,
  extractCurrentSessionTurns,
  findConflictingRuleIds,
  isInjectableStrategy,
  isStaleStrategy,
  selectCreditTargetLlm,
  selectCreditTargetSemantic,
  strategyTextSimilarity,
  type DistillStrategyOptions,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "@muse/agent-core";
import { createGateEmbedder, resolveLearningPauseFile, resolvePlaybookFile } from "@muse/autoconfigure";
import { errorMessage } from "@muse/shared";
import { adjustPlaybookReward, isLearningPaused, queryPlaybook, recordPlaybookStrategy } from "@muse/stores";

import { readLastChatHistory, readSessionBoundaries } from "./chat-history.js";
import { readSessionInjectedIds } from "./playbook-injections.js";
import { withBestEffort } from "./async-promises.js";

type ModelProviderLike = DistillStrategyOptions["modelProvider"];

const DEFAULT_DEDUP_THRESHOLD = 0.6;
const DEFAULT_MAX_EXCHANGES = 2;
/** Reward change for the strategy a correction implicates (RL decay) / an approval endorses (RL reinforce). */
const DECAY_DELTA = -1;
const REINFORCE_DELTA = 1;
/**
 * A strategy must share at least this much (Jaccard, CJK-aware) with the
 * corrected/approved request to be the "implicated" one whose reward moves.
 * Conservative on purpose: an unrelated strategy is never touched, and a
 * cross-script (KO strategy vs EN request) pair scores ~0 and is left alone.
 */

export interface DistillCorrectionsOptions {
  readonly modelProvider: ModelProviderLike;
  readonly model: string;
  /** Owner when the session boundary didn't carry a userId. */
  readonly userId?: string;
  /** Override the playbook path (env: `MUSE_PLAYBOOK_FILE`). */
  readonly playbookFile?: string;
  /** Cap corrections distilled per session. Default 2. */
  readonly maxExchanges?: number;
  /** A distilled strategy is dropped when this similar to an existing one. Default 0.6. */
  readonly dedupThreshold?: number;
  /** Min similarity for an existing strategy to be the one a correction/approval moves. Default 0.1. */
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
  /** Embedder for the distiller's held-out support gate; defaults to the shared gate embedder. */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /**
   * Session-scoped injected-id reader (defaults to the on-disk
   * `playbook-injections.jsonl` record). When it returns a non-empty set,
   * reward credit is restricted to those ACTUALLY-injected strategies; an
   * empty set means the session predates the record (legacy) and the cosine
   * derivation stays authoritative.
   */
  readonly readInjectedIds?: (args: { readonly sinceIso: string; readonly userId: string }) => Promise<ReadonlySet<string>>;
  /**
   * k drafts for the self-consistency write-admission gate (default 3 in the
   * primitive). Set 1 to disable the gate (admit a single draft). Tests inject
   * a small deterministic k.
   */
  readonly strategyConsistencySamples?: number;
}

/** A strategy whose reward moved this session, with the new (clamped) reward. */
interface RewardedStrategy {
  readonly text: string;
  readonly reward: number;
}

export type DistillResult =
  | { readonly status: "recorded"; readonly strategies: readonly { readonly text: string; readonly tag?: string }[]; readonly decayed: readonly RewardedStrategy[]; readonly reinforced: readonly RewardedStrategy[]; readonly lowConsistencyRejected: number }
  | { readonly status: "skipped"; readonly reason: string; readonly decayed: readonly RewardedStrategy[]; readonly reinforced: readonly RewardedStrategy[]; readonly lowConsistencyRejected: number };

/**
 * The corrections THIS session is already learning from its own turns.
 *
 * The capture hook queues a correction on every surface, chat included, so the
 * queue and the session turn-scan overlap exactly here. The session-end drain
 * passes this set as its skip so the same thing the user said once is not counted
 * twice — a double count is how a one-off remark gets promoted into a rule.
 *
 * Fail-soft: an unreadable history yields an empty set, and the drain then simply
 * relearns what the turn scan already did (absorbed by bank dedup). Losing the
 * skip degrades quality; it never loses a lesson.
 */
export async function sessionCorrectionTexts(userId?: string): Promise<ReadonlySet<string>> {
  const [lines, boundaries] = await Promise.all([readLastChatHistory(), readSessionBoundaries()]);
  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range || !(range.userId ?? userId)) {
    return new Set();
  }
  return new Set(detectCorrections(range.turns, { maxExchanges: DEFAULT_MAX_EXCHANGES }).map((c) => c.correction.trim()));
}

export async function distillSessionCorrections(options: DistillCorrectionsOptions): Promise<DistillResult> {
  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `pb_${randomUUID()}`);
  const env = (options.readEnv ?? (() => process.env))();
  const threshold = options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;

  // The learning-pause kill switch. `muse playbook pause` promises the user
  // "Muse won't learn anything new" — that promise has to hold on THIS path
  // too, which is the one that actually runs at the end of every session
  // (the daemon ticks checked it; this did not). It gates BOTH halves: no new
  // strategy is distilled AND no existing reward moves, since a decay is
  // unlearning and the pause forbids learning in either direction.
  if (await isLearningPaused(resolveLearningPauseFile(env))) {
    return { decayed: [], lowConsistencyRejected: 0, reason: "learning is paused (muse playbook resume)", reinforced: [], status: "skipped" };
  }

  let lines: readonly SessionTurnLine[];
  let boundaries: readonly SessionBoundaryRef[];
  try {
    [lines, boundaries] = await Promise.all([readLines(), readBoundaries()]);
  } catch (cause) {
    return { decayed: [], reason: `history read failed: ${errorMessage(cause)}`, reinforced: [], status: "skipped", lowConsistencyRejected: 0 };
  }

  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return { decayed: [], reason: "no current-session range (no boundary or no turns yet)", reinforced: [], status: "skipped", lowConsistencyRejected: 0 };
  }
  const ownerId = range.userId ?? options.userId;
  if (!ownerId) {
    return { decayed: [], reason: "no userId available (boundary missing it, no fallback supplied)", reinforced: [], status: "skipped", lowConsistencyRejected: 0 };
  }

  const maxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const corrections = detectCorrections(range.turns, { maxExchanges });
  const approvals = detectApprovals(range.turns, { maxExchanges });
  if (corrections.length === 0 && approvals.length === 0) {
    return { decayed: [], reason: "no user corrections or approvals in this session", reinforced: [], status: "skipped", lowConsistencyRejected: 0 };
  }

  const playbookFile = options.playbookFile ?? resolvePlaybookFile(env);
  const existing = await queryPlaybook(playbookFile, ownerId);
  const existingTexts = existing.map((entry) => entry.text);
  const adjustedIds = new Set<string>();
  const embed = options.embed ?? createGateEmbedder(process.env);
  // The ids the injection layer RECORDED for this session (fail-soft: an
  // unreadable record behaves like a legacy session — cosine derivation).
  const readInjectedIds = options.readInjectedIds ?? readSessionInjectedIds;
  let sessionInjectedIds: ReadonlySet<string>;
  try {
    sessionInjectedIds = await readInjectedIds({ sinceIso: range.startedAt, userId: ownerId });
  } catch {
    sessionInjectedIds = new Set();
  }

  // Credit-assign explicit feedback to the existing strategy the cue implicates,
  // then move that strategy's reward — once per strategy per session (a strategy
  // is never both decayed and reinforced). Runs before distillation so a freshly
  // -distilled strategy is never its own culprit. SEMANTIC selection first
  // (Memory-R2 arXiv:2605.21768): the strategy text (terse imperative) and the
  // request cue (user prose) are different distributions, so lexical Jaccard
  // mis-/no-credits a paraphrase or cross-lingual pair — mis-credited reward then
  // replays via experience-following (arXiv:2505.16067). Lexical is the fail-soft
  // fallback when the embedder is unavailable.
  const moveReward = async (cue: string, delta: number): Promise<RewardedStrategy | undefined> => {
    if (cue.trim().length === 0) {
      return undefined;
    }
    // Credit only a strategy that COULD have steered this session — exactly the set the
    // injection ranker injects (`isInjectableStrategy && !isStaleStrategy`, playbook.ts).
    // Without this, a PROBATION guess (never injected by contract) or an AVOIDED/stale
    // strategy can absorb a cue-similar reward it had no causal role in — a fabricated
    // reward attribution that replays via experience-following (arXiv:2505.16067). Parity
    // with the decay daemon (decay-contradicted.ts), which already scopes to injectable.
    const nowMs = Date.now();
    const injectable = existing.filter(
      (entry) => !adjustedIds.has(entry.id) && isInjectableStrategy(entry) && !isStaleStrategy(entry, nowMs)
    );
    // INJECTED-ID precision refinement: when the injection layer recorded
    // which strategies this session's prompts ACTUALLY carried, only those may
    // absorb credit — a cue-similar strategy that was never injected had no
    // causal role, so crediting it is fabricated reward attribution. An empty
    // intersection therefore moves NOTHING (fail-closed), while an absent
    // record (legacy session / non-runtime turns) keeps the injectable set.
    const candidates = sessionInjectedIds.size > 0
      ? injectable.filter((entry) => sessionInjectedIds.has(entry.id))
      : injectable;
    // Asymmetric precision: a DECAY (delta<0) must clear a HIGHER cue↔strategy
    // match than a reinforce — a wrong decay of a (possibly grounded) strategy is
    // costlier than a missed reinforce (Memory-R2 arXiv:2605.21768; WEDGE).
    const creditFloor = delta < 0 ? DEFAULT_PLAYBOOK_DECAY_CREDIT_COSINE : DEFAULT_PLAYBOOK_CREDIT_COSINE;
    const creditMargin = delta < 0 ? PLAYBOOK_DECAY_CREDIT_MARGIN : PLAYBOOK_CREDIT_MARGIN;
    // The MODEL decides which rule the feedback is about; cosine is the cheap,
    // conservative fallback. Measured (bank of 5 → 30 rules, KO+EN):
    //   cosine: 9/11 → 4/11 credited, and a mis-credit appears at scale
    //   model : 12/12 → 12/12 credited, 0 mis-credits
    // Cosine cannot carry this decision as the bank densifies (near-neighbours
    // crush the margin, and in a mixed-language bank language identity can
    // outrank meaning). The model is asked one 8-token question and answers NONE
    // when nothing fits — the same shape as the decay-polarity classifier.
    // Fail-soft: a model error yields undefined, and the semantic gate (with its
    // margin) then decides, so the loop never LOSES the old behaviour.
    const targetId =
      (await selectCreditTargetLlm(candidates, cue, { model: options.model, modelProvider: options.modelProvider }))
      ?? (await selectCreditTargetSemantic(candidates, cue, embed, creditFloor, creditMargin));
    // NO lexical fallback. It used to rescue whatever the semantic gate refused —
    // with no margin test and the SAME bar for a decay as for a reinforce — so a
    // cue the semantic gate deliberately fail-closed could still decay a
    // strategy, which is precisely the fabricated attribution the margin gate
    // exists to prevent (arXiv:2505.16067). The semantic verdict is now the only
    // verdict; an embedder that throws already yields `undefined` (fail-soft),
    // and doing nothing is the correct action when credit cannot be assigned.
    const target = targetId === undefined ? undefined : existing.find((entry) => entry.id === targetId);
    if (!target) {
      return undefined;
    }
    adjustedIds.add(target.id);
    try {
      const reward = await adjustPlaybookReward(playbookFile, target.id, delta);
      return reward === undefined ? undefined : { reward, text: target.text };
    } catch {
      return undefined; // fail-soft — a failed reward write must not lose the rest
    }
  };

  // RL decay: a correction means the implicated strategy didn't earn its place.
  const decayed: RewardedStrategy[] = [];
  for (const exchange of corrections) {
    const cue = [exchange.request, exchange.correction].filter((s): s is string => !!s && s.trim().length > 0).join(" ");
    const moved = await moveReward(cue, DECAY_DELTA);
    if (moved) {
      decayed.push(moved);
    }
  }

  // RL reinforce: an explicit approval means the strategy that applied helped.
  const reinforced: RewardedStrategy[] = [];
  for (const approval of approvals) {
    const cue = [approval.request, approval.approval].filter((s): s is string => !!s && s.trim().length > 0).join(" ");
    const moved = await moveReward(cue, REINFORCE_DELTA);
    if (moved) {
      reinforced.push(moved);
    }
  }

  const recorded: { readonly text: string; readonly tag?: string }[] = [];
  // Telemetry sink for the self-consistency gate (fire-10 onReject seam): count
  // distillations dropped for low agreement so the floor's false-reject rate is
  // observable from a real session, not just unit-tested.
  let lowConsistencyRejected = 0;
  for (const exchange of corrections) {
    // Self-consistency WRITE gate (arXiv:2405.01563 / ReasoningBank MaTTS
    // 2509.25140): draw k drafts and bank one only if they AGREE — an unstable
    // (disagreeing ⇒ likely confabulated) distillation is never written.
    const consistent = await distillConsistentStrategy(
      () => distillStrategyFromCorrection(exchange, {
        model: options.model,
        modelProvider: options.modelProvider,
        embed
      }),
      { onReject: () => { lowConsistencyRejected += 1; }, ...(options.strategyConsistencySamples !== undefined ? { samples: options.strategyConsistencySamples } : {}) }
    );
    if (!consistent) {
      continue;
    }
    const distilled = consistent.strategy;
    const isDuplicate = [...existingTexts, ...recorded.map((r) => r.text)].some(
      (text) => strategyTextSimilarity(distilled.text, text) >= threshold
    );
    if (isDuplicate) {
      continue;
    }
    try {
      // Conflict detection runs HERE — at learn time, once, O(n) — never in the
      // per-turn hot path. Compares the freshly-distilled strategy against every
      // currently-injectable existing strategy with the LLM binary classifier
      // (rule-conflict.ts); embedding cosine cannot separate a conflict from a
      // compatible pair (measured, see behavioural-rule-budget.ts). The edge is
      // persisted on the entry so `selectBehaviouralRules` resolves it as a
      // deterministic lookup at inject time, with zero model calls in the turn.
      // Fail-soft: a classifier error records no conflicts, never blocks the write.
      const conflictCandidates = existing.filter((entry) => isInjectableStrategy(entry) && !isStaleStrategy(entry, now().getTime()));
      const conflictsWith = await withBestEffort(findConflictingRuleIds(distilled.text, conflictCandidates, {
        model: options.model,
        modelProvider: options.modelProvider
      }), []);
      await recordPlaybookStrategy(playbookFile, {
        createdAt: now().toISOString(),
        id: idFactory(),
        // Grounded in the real correction; kept as the "why" `muse learned` shows.
        origin: "grounded",
        // Probation is Muse's whole answer to "a single utterance must never become
        // a standing rule" — a strategy on probation is banked but NOT injected until
        // the user reinforces it. The unattended daemon path set it; this path, the
        // one that runs at the end of every chat, did not. So the rule that mattered
        // most was the one that skipped the gate, and a strategy distilled from a
        // single remark could steer the very next turn with no confirmation.
        probation: true,
        source: exchange.correction,
        text: distilled.text,
        userId: ownerId,
        ...(distilled.tag ? { tag: distilled.tag } : {}),
        ...(conflictsWith.length > 0 ? { conflictsWith } : {})
      });
      recorded.push(distilled.tag ? { tag: distilled.tag, text: distilled.text } : { text: distilled.text });
    } catch {
      // Fail-soft per strategy — one bad write must not lose the rest.
    }
  }

  if (recorded.length === 0) {
    const moved = decayed.length + reinforced.length;
    return {
      decayed,
      lowConsistencyRejected,
      reason: moved > 0
        ? `adjusted ${moved.toString()} strateg${moved === 1 ? "y" : "ies"} by feedback; nothing new to distil`
        : "nothing new to record (all distilled strategies were empty or duplicates)",
      reinforced,
      status: "skipped"
    };
  }
  return { decayed, lowConsistencyRejected, reinforced, status: "recorded", strategies: recorded };
}
