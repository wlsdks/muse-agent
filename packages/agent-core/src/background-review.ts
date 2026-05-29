/**
 * Background-review engine — "complete the answer, THEN learn".
 *
 * IDEA borrowed (NOT code) from Hermes-agent's `agent/background_review.py`
 * (Nous Research, MIT — https://github.com/, see THIRD_PARTY_NOTICES.md):
 * after a turn's final response is delivered, a SEPARATE review pass decides
 * what to persist, gated by TWO triggers —
 *   - turn-count            → review MEMORY (persona / preferences / situation)
 *   - tool-iteration-count  → review SKILLS. "Hard tasks teach": a task that
 *     took many tool iterations trips skill review SOONER than idle chat, so
 *     the difficult sessions — the ones worth a reusable skill — are exactly
 *     the ones that get reviewed.
 * Hermes runs this as a forked, tool-whitelisted daemon agent. Muse instead
 * reimplements the idea on its OWN `HookStage` seam: `afterTool` counts tool
 * iterations, `afterComplete` (the answer is already delivered by then) fires
 * the review fire-and-forget. No Hermes code is copied — this is a fresh
 * TypeScript implementation against Muse's contracts.
 *
 * This module (slice 1) is the ENGINE: counters + trigger evaluation + the
 * hook shell. The actual learning pass (`runReview`) is INJECTED and defaults
 * to a no-op, so registering the hook changes no behaviour until a real review
 * is routed in (slices 2–3 fold Muse's existing distillers under it).
 */

import type { AgentRunContext, HookStage } from "./types.js";

export interface ReviewCounters {
  readonly turns: number;
  readonly iters: number;
}

export interface ReviewTriggerConfig {
  /** Review MEMORY once this many turns have completed since the last memory review. <=0 disables. */
  readonly memoryEveryTurns: number;
  /** Review SKILLS once this many tool iterations have accrued since the last skill review. <=0 disables. */
  readonly skillEveryIters: number;
}

export interface ReviewDecision {
  readonly reviewMemory: boolean;
  readonly reviewSkill: boolean;
}

/**
 * Pure trigger evaluation over the CURRENT (post-increment) counters. A
 * channel fires when its accrued count has reached its interval; a non-positive
 * interval disables that channel. Kept pure + exported so the trigger policy is
 * unit-testable without the hook plumbing.
 */
export function evaluateReviewTriggers(counters: ReviewCounters, config: ReviewTriggerConfig): ReviewDecision {
  return {
    reviewMemory: config.memoryEveryTurns > 0 && counters.turns >= config.memoryEveryTurns,
    reviewSkill: config.skillEveryIters > 0 && counters.iters >= config.skillEveryIters
  };
}

/**
 * Per-user counter store. The server is stateless per request, so turn/iter
 * counts must survive between turns; this interface lets the in-memory default
 * (CLI single-process) be swapped for a file-backed impl on the server later
 * (same move N1c's activity tracker made) without touching the engine.
 */
export interface ReviewCounterStore {
  /** Add to a user's counters and return the new state. */
  increment(userId: string, delta: { readonly turns?: number; readonly iters?: number }): ReviewCounters;
  /** Zero the named counters for a user (called after a channel fires). */
  reset(userId: string, fields: { readonly turns?: boolean; readonly iters?: boolean }): void;
}

export function createInMemoryReviewCounterStore(): ReviewCounterStore {
  const byUser = new Map<string, { turns: number; iters: number }>();
  const get = (userId: string): { turns: number; iters: number } => {
    let state = byUser.get(userId);
    if (!state) {
      state = { iters: 0, turns: 0 };
      byUser.set(userId, state);
    }
    return state;
  };
  return {
    increment(userId, delta) {
      const state = get(userId);
      state.turns += delta.turns ?? 0;
      state.iters += delta.iters ?? 0;
      return { iters: state.iters, turns: state.turns };
    },
    reset(userId, fields) {
      const state = get(userId);
      if (fields.turns) state.turns = 0;
      if (fields.iters) state.iters = 0;
    }
  };
}

export interface BackgroundReviewInput {
  readonly context: AgentRunContext;
  readonly userId: string;
  readonly reviewMemory: boolean;
  readonly reviewSkill: boolean;
}

export interface BackgroundReviewHookOptions {
  /** Default 3. */
  readonly memoryEveryTurns?: number;
  /** Default 10. */
  readonly skillEveryIters?: number;
  readonly counters?: ReviewCounterStore;
  /** Default userId when a run carries none in metadata. */
  readonly defaultUserId?: string;
  /**
   * The learning pass. Default no-op (engine inert). Fired FIRE-AND-FORGET
   * from `afterComplete` — the answer is already delivered, so review must
   * never block or alter the turn (Hermes' "main conversation is never
   * touched"). A throw is swallowed to `onError`.
   */
  readonly runReview?: (input: BackgroundReviewInput) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_MEMORY_EVERY_TURNS = 3;
const DEFAULT_SKILL_EVERY_ITERS = 10;

export const BACKGROUND_REVIEW_HOOK_ID = "muse.background-review";

function readUserId(context: AgentRunContext, fallback: string | undefined): string | undefined {
  const value = context.input.metadata?.userId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function createBackgroundReviewHook(options: BackgroundReviewHookOptions = {}): HookStage {
  const memoryEveryTurns = Number.isFinite(options.memoryEveryTurns) ? options.memoryEveryTurns! : DEFAULT_MEMORY_EVERY_TURNS;
  const skillEveryIters = Number.isFinite(options.skillEveryIters) ? options.skillEveryIters! : DEFAULT_SKILL_EVERY_ITERS;
  const counters = options.counters ?? createInMemoryReviewCounterStore();
  const runReview = options.runReview ?? ((): void => undefined);

  return {
    id: BACKGROUND_REVIEW_HOOK_ID,
    afterTool(context) {
      // Hard tasks teach: every tool iteration accrues toward the skill review.
      const userId = readUserId(context, options.defaultUserId);
      if (userId) counters.increment(userId, { iters: 1 });
    },
    afterComplete(context) {
      // The user already has their answer here. Everything below is post-hoc
      // learning that must NOT block or change the turn.
      const userId = readUserId(context, options.defaultUserId);
      if (!userId) return;
      const state = counters.increment(userId, { turns: 1 });
      const decision = evaluateReviewTriggers(state, { memoryEveryTurns, skillEveryIters });
      if (!decision.reviewMemory && !decision.reviewSkill) return;
      // Reset only the channels that fired, so each keeps its own cadence.
      counters.reset(userId, { iters: decision.reviewSkill, turns: decision.reviewMemory });
      // Fire-and-forget: do NOT await — the turn returns immediately.
      void Promise.resolve()
        .then(() => runReview({ context, reviewMemory: decision.reviewMemory, reviewSkill: decision.reviewSkill, userId }))
        .catch((error) => options.onError?.(error));
    }
  };
}
