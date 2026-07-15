/**
 * Chat producer for idle self-learning — at REPL exit, ENQUEUE
 * the corrections the user made this session onto the learn-queue instead of
 * distilling them synchronously. The idle Sleep daemon distills them later,
 * behind the resource brakes, with NO manual step. This is the migration of
 * the exit-only distillation gap: capture the raw exchange when it
 * happens (episodes keep only summaries), distill on idle.
 *
 * Gated SEPARATELY from `MUSE_PLAYBOOK_DISTILL_ENABLED` (the synchronous
 * exit-distill) so the two are mutually exclusive — a correction is never both
 * distilled at exit AND enqueued for idle (no double-distill).
 */
import { randomUUID } from "node:crypto";

import {
  detectCorrections,
  extractCurrentSessionTurns,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "@muse/agent-core";
import { enqueueLearnEvent, isLearningPaused, resolveLearnQueueFile } from "@muse/stores";
import { resolveLearningPauseFile } from "@muse/autoconfigure";

import { readLastChatHistory, readSessionBoundaries } from "./chat-history.js";

export interface EnqueueCorrectionsOptions {
  readonly userId?: string;
  readonly queueFile?: string;
  readonly maxExchanges?: number;
  /** Test seams. */
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface EnqueueCorrectionsResult {
  readonly enqueued: number;
  readonly reason?: string;
}

/**
 * Detect this session's corrections and enqueue each onto the learn-queue for
 * idle distillation. Fail-soft: a history-read error or a session with no
 * correction enqueues nothing (and never throws at exit).
 */
export async function enqueueSessionCorrections(options: EnqueueCorrectionsOptions = {}): Promise<EnqueueCorrectionsResult> {
  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const env = (options.readEnv ?? (() => process.env))();
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `lq_${randomUUID()}`);
  const queueFile = options.queueFile ?? resolveLearnQueueFile(env as Record<string, string | undefined>);

  // Kill switch: when learning is paused, enqueue nothing — a true pause
  // accumulates no corrections to learn on resume.
  if (await isLearningPaused(resolveLearningPauseFile(env as Record<string, string | undefined>))) {
    return { enqueued: 0, reason: "learning is paused" };
  }

  let lines: readonly SessionTurnLine[];
  let boundaries: readonly SessionBoundaryRef[];
  try {
    [lines, boundaries] = await Promise.all([readLines(), readBoundaries()]);
  } catch (cause) {
    return { enqueued: 0, reason: `history read failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return { enqueued: 0, reason: "no current-session range" };
  }
  const ownerId = range.userId ?? options.userId;
  if (!ownerId) {
    return { enqueued: 0, reason: "no userId available" };
  }

  const corrections = detectCorrections(range.turns, { maxExchanges: options.maxExchanges ?? 2 });
  if (corrections.length === 0) {
    return { enqueued: 0, reason: "no user corrections in this session" };
  }

  for (const exchange of corrections) {
    await enqueueLearnEvent(queueFile, {
      correction: exchange.correction,
      enqueuedAtMs: now().getTime(),
      id: idFactory(),
      priorAnswer: exchange.priorAnswer,
      userId: ownerId,
      ...(exchange.request ? { request: exchange.request } : {})
    });
  }
  return { enqueued: corrections.length };
}
