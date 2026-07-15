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

import type { ModelResponse } from "@muse/model";

import type { AgentRunContext, HookStage } from "./types.js";

export interface ReviewCounters {
  readonly turns: number;
  readonly iters: number;
  /** Tool calls in the accrued skill window that returned status "failed". */
  readonly toolFailures: number;
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
 * Salience of the accrued skill window — used to gate the (costly) skill-review
 * pass so it consolidates only experiences worth learning from, not every Nth
 * tool iteration regardless of difficulty.
 */
export interface ReviewSalience {
  readonly toolFailures: number;
  readonly toolCalls: number;
}

/**
 * Write-time salience gate (arXiv:2603.15994, Zahn & Chana 2026 — selective
 * memory via write-time gating beats blind ingestion). A skill captures HOW to
 * handle a hard task; the clearest structural "this was hard" signal is a tool
 * that actually FAILED in the window. A window of only-successful tool calls is
 * low-salience for skill learning — let the cadence accrue toward the next
 * failing turn instead of spending an LLM review pass on it. Structural
 * (tool-status), not lexical — robust across languages/paraphrase.
 */
export function isSkillReviewSalient(salience: ReviewSalience): boolean {
  return salience.toolFailures > 0;
}

/**
 * Pure trigger evaluation over the CURRENT (post-increment) counters. A
 * channel fires when its accrued count has reached its interval; a non-positive
 * interval disables that channel. When `salience` is supplied, the SKILL channel
 * is additionally gated on it (write-time salience gating); absent salience =
 * cadence-only (legacy behaviour). Kept pure + exported so the policy is
 * unit-testable without the hook plumbing.
 */
export function evaluateReviewTriggers(
  counters: ReviewCounters,
  config: ReviewTriggerConfig,
  salience?: ReviewSalience
): ReviewDecision {
  const skillCadenceMet = config.skillEveryIters > 0 && counters.iters >= config.skillEveryIters;
  return {
    reviewMemory: config.memoryEveryTurns > 0 && counters.turns >= config.memoryEveryTurns,
    reviewSkill: skillCadenceMet && (salience === undefined || isSkillReviewSalient(salience))
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
  increment(userId: string, delta: { readonly turns?: number; readonly iters?: number; readonly toolFailures?: number }): ReviewCounters;
  /** Zero the named counters for a user (called after a channel fires). */
  reset(userId: string, fields: { readonly turns?: boolean; readonly iters?: boolean; readonly toolFailures?: boolean }): void;
}

export function createInMemoryReviewCounterStore(): ReviewCounterStore {
  const byUser = new Map<string, { turns: number; iters: number; toolFailures: number }>();
  const get = (userId: string): { turns: number; iters: number; toolFailures: number } => {
    let state = byUser.get(userId);
    if (!state) {
      state = { iters: 0, toolFailures: 0, turns: 0 };
      byUser.set(userId, state);
    }
    return state;
  };
  return {
    increment(userId, delta) {
      const state = get(userId);
      state.turns += delta.turns ?? 0;
      state.iters += delta.iters ?? 0;
      state.toolFailures += delta.toolFailures ?? 0;
      return { iters: state.iters, toolFailures: state.toolFailures, turns: state.turns };
    },
    reset(userId, fields) {
      const state = get(userId);
      if (fields.turns) state.turns = 0;
      if (fields.iters) state.iters = 0;
      if (fields.toolFailures) state.toolFailures = 0;
    }
  };
}

export interface BackgroundReviewInput {
  readonly context: AgentRunContext;
  readonly response: ModelResponse;
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
  // One review per user in flight at a time (Hermes runs a single review
  // daemon). Without this, a fast follow-up turn can start a second review pass
  // while the first is still writing — racing the memory/skill store's RMW.
  const inFlight = new Set<string>();

  return {
    id: BACKGROUND_REVIEW_HOOK_ID,
    afterTool(context, _toolCall, result) {
      // Hard tasks teach: every tool iteration accrues toward the skill review,
      // and a FAILED tool is the salience signal that the window is worth a
      // skill-review pass (write-time gating, arXiv:2603.15994).
      const userId = readUserId(context, options.defaultUserId);
      if (userId) counters.increment(userId, { iters: 1, toolFailures: result.status === "failed" ? 1 : 0 });
    },
    afterComplete(context, response) {
      // The user already has their answer here. Everything below is post-hoc
      // learning that must NOT block or change the turn.
      const userId = readUserId(context, options.defaultUserId);
      if (!userId) return;
      const state = counters.increment(userId, { turns: 1 });
      const salience: ReviewSalience = { toolCalls: state.iters, toolFailures: state.toolFailures };
      const decision = evaluateReviewTriggers(state, { memoryEveryTurns, skillEveryIters }, salience);
      if (!decision.reviewMemory && !decision.reviewSkill) return;
      // A trigger tripped while this user's prior review is still running: do
      // NOT start a concurrent pass. Leave the counters unreset so the trigger
      // stays tripped and the review re-fires (coalesced into one) on the next
      // turn after the in-flight pass clears — no trigger is lost.
      if (inFlight.has(userId)) return;
      inFlight.add(userId);
      // Fire-and-forget: do NOT await — the turn returns immediately. Reset the
      // fired channels ONLY after the review actually RESOLVES, so a review whose
      // arm throws leaves its trigger tripped and re-fires next turn — the same
      // "no trigger is lost" invariant the in-flight-skip path holds (MAST
      // fail-close: a failed sub-step must not silently discard its retrigger).
      void Promise.resolve()
        .then(() => runReview({ context, response, reviewMemory: decision.reviewMemory, reviewSkill: decision.reviewSkill, userId }))
        .then(() => { counters.reset(userId, { iters: decision.reviewSkill, toolFailures: decision.reviewSkill, turns: decision.reviewMemory }); })
        .catch((error) => options.onError?.(error))
        .finally(() => { inFlight.delete(userId); });
    }
  };
}
