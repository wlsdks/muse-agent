/**
 * Idle distill-consumer (B1 Slice 1) — drains the learn-queue ON IDLE, behind
 * the resource brakes, turning a queued correction into a learned strategy
 * with NO manual step. At most ONE event per tick (the LLM call is the cost),
 * then yields. Grounding fence: an event with no real correction text, or a
 * distiller that returns nothing, writes ZERO strategies — a non-corrective
 * signal never fabricates a "lesson". Every drained event is marked done so
 * the queue drains steadily. (PART A2 / B1.)
 */
import type { ModelProvider } from "@muse/model";
import {
  distillStrategyFromCorrection,
  strategyTextSimilarity,
  type CorrectionExchange,
  type DistilledStrategy
} from "@muse/agent-core";
import {
  incrementSuppressionBlocked,
  isLearningPaused,
  markLearnEventsDone,
  querySuppressedLessons,
  readPendingLearnEvents,
  recordPlaybookStrategy,
  type LearnCorrectionEvent
} from "@muse/mcp";

export interface DistillQueuedDeps {
  readonly queueFile: string;
  readonly playbookFile: string;
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  /** Embedder for the distiller's held-out support gate (parity with preference). */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /**
   * "Undo that teaches" (B1 §5): the suppressed-lessons store. When set, a
   * freshly-distilled strategy that closely matches a lesson the user UNDID is
   * NOT re-recorded (the veto's blocked counter is bumped instead). Omitted ⇒
   * no suppression check (back-compat).
   */
  readonly suppressedLessonsFile?: string;
  /** Similarity ≥ this ⇒ a new lesson counts as the suppressed one. Default 0.6. */
  readonly suppressionThreshold?: number;
  /**
   * Learning pause switch (B1 §5 kill switch). When set AND paused, this tick
   * does NOTHING — zero distills, zero playbook writes, queue left intact so a
   * later resume catches up. Omitted ⇒ no pause check (back-compat).
   */
  readonly pauseFile?: string;
  /** ≤ this many events distilled per tick (the LLM call is the cost). Default 1. */
  readonly maxPerTick?: number;
  /** Injectable clock + id for tests. */
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Test seam — defaults to the real local-Qwen distiller. */
  readonly distill?: (exchange: CorrectionExchange, options: { model: string; modelProvider: Pick<ModelProvider, "generate">; embed?: (text: string) => Promise<readonly number[]> }) => Promise<DistilledStrategy | undefined>;
}

/** Returns the number of strategies actually recorded this tick. */
export async function distillQueuedCorrections(deps: DistillQueuedDeps): Promise<number> {
  // Kill switch (B1 §5): paused ⇒ zero writes, queue untouched (resume catches up).
  if (deps.pauseFile && (await isLearningPaused(deps.pauseFile))) {
    return 0;
  }
  const pending = await readPendingLearnEvents(deps.queueFile);
  if (pending.length === 0) {
    return 0;
  }
  const cap = Math.max(1, deps.maxPerTick ?? 1);
  const batch = pending.slice(0, cap);
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `pb_${now().getTime().toString(36)}_${Math.trunc(performance.now()).toString(36)}`);
  const distill = deps.distill ?? ((exchange, options) =>
    distillStrategyFromCorrection(exchange, options as Parameters<typeof distillStrategyFromCorrection>[1]));

  const doneIds: string[] = [];
  let recorded = 0;
  for (const event of batch) {
    doneIds.push(event.id); // consumed regardless — a dud signal must not jam the queue
    if (event.correction.trim().length === 0) {
      continue; // grounding fence: no real correction ⇒ no lesson
    }
    // "Undo that teaches" (B1 §5): if the user previously UNDID a lesson learned
    // from THIS correction, don't silently re-learn it. Match the incoming
    // correction (the stable signal) against the veto's source — NOT the LLM's
    // paraphrased output, which varies run to run — and skip BEFORE the costly
    // distill call, bumping the veto's blocked counter.
    if (deps.suppressedLessonsFile) {
      const threshold = deps.suppressionThreshold ?? 0.6;
      const suppressed = await querySuppressedLessons(deps.suppressedLessonsFile, event.userId);
      const match = suppressed.find((s) => s.source !== undefined && strategyTextSimilarity(event.correction, s.source) >= threshold);
      if (match) {
        await incrementSuppressionBlocked(deps.suppressedLessonsFile, match.id);
        continue;
      }
    }
    const exchange = exchangeFromEvent(event);
    const strategy = await distill(exchange, { model: deps.model, modelProvider: deps.modelProvider, ...(deps.embed ? { embed: deps.embed } : {}) });
    if (!strategy || strategy.text.trim().length === 0) {
      continue; // distiller fail-soft / NONE ⇒ no write
    }
    await recordPlaybookStrategy(deps.playbookFile, {
      createdAt: now().toISOString(),
      id: newId(),
      // Unattended write ⇒ PROBATION: recorded + visible but not injected
      // until a real reinforce graduates it (self-confirmation guard, B1 §5).
      probation: true,
      // Provenance (B1 §4): distilled from a REAL correction ⇒ grounded; keep
      // the correction as the "why" `muse learned` shows.
      origin: "grounded",
      source: event.correction,
      text: strategy.text,
      userId: event.userId,
      ...(strategy.tag ? { tag: strategy.tag } : {})
    });
    recorded += 1;
  }
  await markLearnEventsDone(deps.queueFile, doneIds);
  return recorded;
}

function exchangeFromEvent(event: LearnCorrectionEvent): CorrectionExchange {
  return {
    correction: event.correction,
    priorAnswer: event.priorAnswer,
    ...(event.request ? { request: event.request } : {})
  };
}
