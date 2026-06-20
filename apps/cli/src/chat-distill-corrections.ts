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
  detectApprovals,
  detectCorrections,
  distillConsistentStrategy,
  distillStrategyFromCorrection,
  extractCurrentSessionTurns,
  selectCreditTargetSemantic,
  strategyTextSimilarity,
  type DistillStrategyOptions,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "@muse/agent-core";
import { createGateEmbedder, resolvePlaybookFile } from "@muse/autoconfigure";
import { adjustPlaybookReward, queryPlaybook, recordPlaybookStrategy, type PlaybookEntry } from "@muse/mcp";

import { readLastChatHistory, readSessionBoundaries } from "./chat-history.js";

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
const DEFAULT_FEEDBACK_THRESHOLD = 0.1;

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
  readonly feedbackThreshold?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
  /** Embedder for the distiller's held-out support gate; defaults to the shared gate embedder. */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /**
   * k drafts for the self-consistency write-admission gate (default 3 in the
   * primitive). Set 1 to disable the gate (admit a single draft). Tests inject
   * a small deterministic k.
   */
  readonly strategyConsistencySamples?: number;
}

/** A strategy whose reward moved this session, with the new (clamped) reward. */
export interface RewardedStrategy {
  readonly text: string;
  readonly reward: number;
}
/** Back-compat alias: a strategy a correction decayed. */
export type DecayedStrategy = RewardedStrategy;

export type DistillResult =
  | { readonly status: "recorded"; readonly strategies: readonly { readonly text: string; readonly tag?: string }[]; readonly decayed: readonly RewardedStrategy[]; readonly reinforced: readonly RewardedStrategy[]; readonly lowConsistencyRejected: number }
  | { readonly status: "skipped"; readonly reason: string; readonly decayed: readonly RewardedStrategy[]; readonly reinforced: readonly RewardedStrategy[]; readonly lowConsistencyRejected: number };

export async function distillSessionCorrections(options: DistillCorrectionsOptions): Promise<DistillResult> {
  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `pb_${randomUUID()}`);
  const env = (options.readEnv ?? (() => process.env))();
  const threshold = options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;

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

  const playbookFile = options.playbookFile ?? resolvePlaybookFile(env as Record<string, string | undefined>);
  const existing = await queryPlaybook(playbookFile, ownerId);
  const existingTexts = existing.map((entry) => entry.text);
  const feedbackThreshold = options.feedbackThreshold ?? DEFAULT_FEEDBACK_THRESHOLD;
  const adjustedIds = new Set<string>();
  const embed = options.embed ?? createGateEmbedder(process.env);

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
    const candidates = existing.filter((entry) => !adjustedIds.has(entry.id));
    // Asymmetric precision: a DECAY (delta<0) must clear a HIGHER cue↔strategy
    // match than a reinforce — a wrong decay of a (possibly grounded) strategy is
    // costlier than a missed reinforce (Memory-R2 arXiv:2605.21768; WEDGE).
    const creditFloor = delta < 0 ? DEFAULT_PLAYBOOK_DECAY_CREDIT_COSINE : DEFAULT_PLAYBOOK_CREDIT_COSINE;
    let targetId = await selectCreditTargetSemantic(candidates, cue, embed, creditFloor);
    if (targetId === undefined) {
      let best: { readonly entry: PlaybookEntry; readonly sim: number } | undefined;
      for (const entry of candidates) {
        const sim = strategyTextSimilarity(entry.text, cue);
        if (sim >= feedbackThreshold && (!best || sim > best.sim)) {
          best = { entry, sim };
        }
      }
      targetId = best?.entry.id;
    }
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
      await recordPlaybookStrategy(playbookFile, {
        createdAt: now().toISOString(),
        id: idFactory(),
        // Provenance (B1 §4): grounded in the real correction; keep it as the
        // "why" `muse learned` shows.
        origin: "grounded",
        source: exchange.correction,
        text: distilled.text,
        userId: ownerId,
        ...(distilled.tag ? { tag: distilled.tag } : {})
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
