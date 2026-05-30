/**
 * ReasoningBank slice 2 (arXiv 2509.25140): end-of-session auto-distillation.
 * Reads the just-finished session, finds where the user CORRECTED the
 * assistant, asks the model to generalise each correction into one reusable
 * strategy, dedupes it against the existing bank, and records it into the SAME
 * `~/.muse/playbook.json` the [Learned Strategies] injection reads. The
 * positive feedback loop for the ACE playbook, populated automatically.
 *
 * Mirrors `captureEndOfSessionEpisode`: I/O is injectable, every step is
 * fail-soft, and it returns a typed skip reason rather than throwing. The env
 * gate (`MUSE_PLAYBOOK_DISTILL_ENABLED`) is checked by the REPL-exit caller so
 * the manual `muse playbook distill` command can run regardless.
 */

import { randomUUID } from "node:crypto";

import {
  detectCorrections,
  distillStrategyFromCorrection,
  extractCurrentSessionTurns,
  strategyTextSimilarity,
  type DistillStrategyOptions,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "@muse/agent-core";
import { resolvePlaybookFile } from "@muse/autoconfigure";
import { adjustPlaybookReward, queryPlaybook, recordPlaybookStrategy, type PlaybookEntry } from "@muse/mcp";

import { readLastChatHistory, readSessionBoundaries } from "./chat-history.js";

type ModelProviderLike = DistillStrategyOptions["modelProvider"];

const DEFAULT_DEDUP_THRESHOLD = 0.6;
const DEFAULT_MAX_EXCHANGES = 2;
/** Reward change applied to the strategy a correction implicates (the RL decay step). */
const DECAY_DELTA = -1;
/**
 * A strategy must share at least this much (Jaccard, CJK-aware) with the
 * corrected request+correction to be the "implicated" one that gets decayed.
 * Conservative on purpose: an unrelated strategy is never penalised, and a
 * cross-script (KO strategy vs EN request) pair scores ~0 and is left alone.
 */
const DEFAULT_DECAY_THRESHOLD = 0.1;

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
  /** Min similarity for an existing strategy to be decayed as the correction's culprit. Default 0.1. */
  readonly decayThreshold?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
}

/** A strategy whose reward was decayed because a correction implicated it. */
export interface DecayedStrategy {
  readonly text: string;
  readonly reward: number;
}

export type DistillResult =
  | { readonly status: "recorded"; readonly strategies: readonly { readonly text: string; readonly tag?: string }[]; readonly decayed: readonly DecayedStrategy[] }
  | { readonly status: "skipped"; readonly reason: string; readonly decayed: readonly DecayedStrategy[] };

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
    return { decayed: [], reason: `history read failed: ${errorMessage(cause)}`, status: "skipped" };
  }

  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return { decayed: [], reason: "no current-session range (no boundary or no turns yet)", status: "skipped" };
  }
  const ownerId = range.userId ?? options.userId;
  if (!ownerId) {
    return { decayed: [], reason: "no userId available (boundary missing it, no fallback supplied)", status: "skipped" };
  }

  const exchanges = detectCorrections(range.turns, { maxExchanges: options.maxExchanges ?? DEFAULT_MAX_EXCHANGES });
  if (exchanges.length === 0) {
    return { decayed: [], reason: "no user corrections in this session", status: "skipped" };
  }

  const playbookFile = options.playbookFile ?? resolvePlaybookFile(env as Record<string, string | undefined>);
  const existing = await queryPlaybook(playbookFile, ownerId);
  const existingTexts = existing.map((entry) => entry.text);

  // RL decay step: a correction means the strategy that applied here didn't
  // earn its place — find the existing strategy most similar to the corrected
  // request+correction and dock its reward (once per strategy per session) so a
  // repeatedly-corrected one sinks out of injection. Runs before distillation
  // so a freshly-distilled strategy is never flagged as its own culprit.
  const decayThreshold = options.decayThreshold ?? DEFAULT_DECAY_THRESHOLD;
  const decayed: DecayedStrategy[] = [];
  const decayedIds = new Set<string>();
  for (const exchange of exchanges) {
    const cue = [exchange.request, exchange.correction].filter((s): s is string => !!s && s.trim().length > 0).join(" ");
    let culprit: { readonly entry: PlaybookEntry; readonly sim: number } | undefined;
    for (const entry of existing) {
      if (decayedIds.has(entry.id)) {
        continue;
      }
      const sim = strategyTextSimilarity(entry.text, cue);
      if (sim >= decayThreshold && (!culprit || sim > culprit.sim)) {
        culprit = { entry, sim };
      }
    }
    if (!culprit) {
      continue;
    }
    decayedIds.add(culprit.entry.id);
    try {
      const reward = await adjustPlaybookReward(playbookFile, culprit.entry.id, DECAY_DELTA);
      if (reward !== undefined) {
        decayed.push({ reward, text: culprit.entry.text });
      }
    } catch {
      // Fail-soft — a failed reward write must not lose the distillation below.
    }
  }

  const recorded: { readonly text: string; readonly tag?: string }[] = [];

  for (const exchange of exchanges) {
    const distilled = await distillStrategyFromCorrection(exchange, {
      model: options.model,
      modelProvider: options.modelProvider
    });
    if (!distilled) {
      continue;
    }
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
    return { decayed, reason: "nothing new to record (all distilled strategies were empty or duplicates)", status: "skipped" };
  }
  return { decayed, status: "recorded", strategies: recorded };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
