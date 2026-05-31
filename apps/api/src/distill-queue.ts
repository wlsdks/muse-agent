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
  type CorrectionExchange,
  type DistilledStrategy
} from "@muse/agent-core";
import {
  markLearnEventsDone,
  readPendingLearnEvents,
  recordPlaybookStrategy,
  type LearnCorrectionEvent
} from "@muse/mcp";

export interface DistillQueuedDeps {
  readonly queueFile: string;
  readonly playbookFile: string;
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  /** ≤ this many events distilled per tick (the LLM call is the cost). Default 1. */
  readonly maxPerTick?: number;
  /** Injectable clock + id for tests. */
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Test seam — defaults to the real local-Qwen distiller. */
  readonly distill?: (exchange: CorrectionExchange, options: { model: string; modelProvider: Pick<ModelProvider, "generate"> }) => Promise<DistilledStrategy | undefined>;
}

/** Returns the number of strategies actually recorded this tick. */
export async function distillQueuedCorrections(deps: DistillQueuedDeps): Promise<number> {
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
    const exchange = exchangeFromEvent(event);
    const strategy = await distill(exchange, { model: deps.model, modelProvider: deps.modelProvider });
    if (!strategy || strategy.text.trim().length === 0) {
      continue; // distiller fail-soft / NONE ⇒ no write
    }
    await recordPlaybookStrategy(deps.playbookFile, {
      createdAt: now().toISOString(),
      id: newId(),
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
