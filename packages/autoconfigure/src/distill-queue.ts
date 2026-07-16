/**
 * Idle distill-consumer (B1 Slice 1) — drains the learn-queue ON IDLE, behind
 * the resource brakes, turning a queued correction into a learned strategy
 * with NO manual step. At most ONE event per tick (the LLM call is the cost —
 * note the self-consistency gate draws k=`strategyConsistencySamples` drafts,
 * default 3, so it is k LLM calls per event; set 1 to disable), then yields.
 * Grounding fence: an event with no real correction text, or a
 * distiller that returns nothing, writes ZERO strategies — a non-corrective
 * signal never fabricates a "lesson". Every drained event is marked done so
 * the queue drains steadily. (PART A2 / B1.)
 *
 * Lives here (not in an app) so EVERY surface that runs a background loop — the
 * `apps/api` server tick AND the `muse daemon` CLI — drains the same queue with
 * the same grounding fence + brakes, instead of each app forking the logic.
 */
import type { ModelProvider } from "@muse/model";
import {
  distillConsistentStrategy,
  distillStrategyFromCorrection,
  findConflictingRuleIds,
  isInjectableStrategy,
  isStaleStrategy,
  strategyTextSimilarity,
  type CorrectionExchange,
  type DistilledStrategy
} from "@muse/agent-core";
import { bumpPlaybookObservation, incrementSuppressionBlocked, isLearningPaused, markLearnEventsDone, queryPlaybook, querySuppressedLessons, readPendingLearnEvents, recordPlaybookStrategy, type LearnCorrectionEvent } from "@muse/stores";

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
   * Bank dedup (ReasoningBank): a freshly-distilled lesson whose
   * `strategyTextSimilarity` to an EXISTING bank entry is ≥ this is treated as
   * the user raising the SAME point again — its observation count is bumped
   * instead of writing a paraphrase duplicate (sign-safe: never graduates the
   * matched entry). Default 0.7. Omitted ⇒ the default applies.
   */
  readonly dedupThreshold?: number;
  /**
   * Learning pause switch (B1 §5 kill switch). When set AND paused, this tick
   * does NOTHING — zero distills, zero playbook writes, queue left intact so a
   * later resume catches up. Omitted ⇒ no pause check (back-compat).
   */
  readonly pauseFile?: string;
  /** ≤ this many events distilled per tick (the LLM call is the cost). Default 1. */
  readonly maxPerTick?: number;
  /**
   * Drop an event WITHOUT distilling it, and consume it so it cannot jam the queue.
   *
   * The capture hook enqueues on every surface, chat included — but the chat's
   * end-of-session pipeline ALSO scans its own turns, so a correction typed in
   * chat would otherwise be distilled twice. That is not a harmless duplicate: the
   * bank dedup would absorb the second copy by BUMPING the strategy's observation
   * count, and a single thing the user said once would look like they had said it
   * twice — which is exactly how a one-off remark graduates into a standing rule.
   * The session pipeline passes its own turns here so the queue skips them.
   */
  readonly skipCorrection?: (correction: string) => boolean;
  /** Injectable clock + id for tests. */
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Test seam — defaults to the real local-Qwen distiller. */
  readonly distill?: (exchange: CorrectionExchange, options: { model: string; modelProvider: Pick<ModelProvider, "generate">; embed?: (text: string) => Promise<readonly number[]> }) => Promise<DistilledStrategy | undefined>;
  /** Self-consistency draws for the autonomous write gate (parity with the sync distiller). Default = the gate's own default (3). */
  readonly strategyConsistencySamples?: number;
}

function normalizeMaxPerTick(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

/** Returns the number of strategies actually recorded this tick. */
export async function distillQueuedCorrections(deps: DistillQueuedDeps): Promise<number> {
  // Kill switch: paused ⇒ zero writes, queue untouched (resume catches up).
  if (deps.pauseFile && (await isLearningPaused(deps.pauseFile))) {
    return 0;
  }
  const pending = await readPendingLearnEvents(deps.queueFile);
  if (pending.length === 0) {
    return 0;
  }
  const cap = normalizeMaxPerTick(deps.maxPerTick);
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
    if (deps.skipCorrection?.(event.correction)) {
      continue; // already being learned by the caller (the session's own turn scan)
    }
    // "Undo that teaches": if the user previously UNDID a lesson learned
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
    // Self-consistency WRITE gate (arXiv:2405.01563 / ReasoningBank MaTTS
    // 2509.25140) — SIBLING PARITY with the sync distiller (chat-distill-corrections):
    // the autonomous idle learner ALSO draws k drafts and banks one only if they
    // AGREE, so an unstable (disagreeing ⇒ likely confabulated) distillation is
    // never auto-written — even though an idle write only lands on probation, a
    // confabulated probation strategy still gets injected and wastes a slot.
    const consistent = await distillConsistentStrategy(
      () => distill(exchange, { model: deps.model, modelProvider: deps.modelProvider, ...(deps.embed ? { embed: deps.embed } : {}) }),
      deps.strategyConsistencySamples !== undefined ? { samples: deps.strategyConsistencySamples } : {}
    );
    const strategy = consistent?.strategy;
    if (!strategy || strategy.text.trim().length === 0) {
      continue; // distiller fail-soft / NONE / inconsistent draws ⇒ no write
    }
    // Bank dedup (ReasoningBank): if this lesson paraphrases one the bank already
    // holds, consolidate instead of writing a duplicate — bump the existing
    // entry's observation count. SIGN-SAFE: a repeated correction is a NEGATIVE
    // signal, so this NEVER touches reward/probation (a probation guess is not
    // graduated off the back of a repeat — graduation stays bound to a positive
    // user act); it only records that the user raised the same point again.
    const dedupThreshold = deps.dedupThreshold ?? 0.7;
    const bankEntries = await queryPlaybook(deps.playbookFile, event.userId);
    let bestMatch: { readonly id: string; readonly similarity: number } | undefined;
    for (const entry of bankEntries) {
      const similarity = strategyTextSimilarity(strategy.text, entry.text);
      if (similarity >= dedupThreshold && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { id: entry.id, similarity };
      }
    }
    if (bestMatch) {
      await bumpPlaybookObservation(deps.playbookFile, bestMatch.id);
      continue; // consolidated into the existing lesson — no duplicate, no graduation
    }
    // Conflict detection at learn time — O(n), once, never in the per-turn hot
    // path (see rule-conflict.ts / behavioural-rule-budget.ts for why cosine
    // can't do this). Fail-soft: a classifier error records no conflicts.
    const conflictCandidates = bankEntries.filter((entry) => isInjectableStrategy(entry) && !isStaleStrategy(entry, now().getTime()));
    const conflictsWith = await findConflictingRuleIds(strategy.text, conflictCandidates, {
      model: deps.model,
      modelProvider: deps.modelProvider
    }).catch(() => []);
    await recordPlaybookStrategy(deps.playbookFile, {
      createdAt: now().toISOString(),
      id: newId(),
      // Unattended write ⇒ PROBATION: recorded + visible but not injected
      // until a real reinforce graduates it (self-confirmation guard).
      probation: true,
      // Provenance: distilled from a REAL correction ⇒ grounded; keep
      // the correction as the "why" `muse learned` shows.
      origin: "grounded",
      source: event.correction,
      text: strategy.text,
      userId: event.userId,
      ...(strategy.tag ? { tag: strategy.tag } : {}),
      ...(conflictsWith.length > 0 ? { conflictsWith } : {})
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
