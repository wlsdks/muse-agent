/**
 * Background-review arm factories — extracted from
 * `createMuseRuntimeAssembly` so the composition root no longer carries
 * the budgeted-LLM-detector closure and the three review-arm closure
 * builders inline. Each factory takes an explicit deps object the
 * assembly threads through; behaviour is preserved line-for-line.
 */

import {
  extractFollowupPromisesLlm,
  reviewSkillsFromTurns,
  type BackgroundReviewInput,
  type SessionTurnLine
} from "@muse/agent-core";
import {
  formatFollowupLlmBudgetDay,
  incrementFollowupLlmBudget,
  isFollowupLlmBudgetExhausted,
  readFollowupLlmBudget
} from "@muse/mcp";
import type { UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import { AuthoredSkillStore } from "@muse/skills";

import { createGateEmbedder } from "./context-engineering-builders.js";
import { inferPreferencesFromTurns, scanCommitmentsFromTurns } from "./context-engineering-turn-analysis.js";
import { parseBoolean } from "./env-parsers.js";
import { resolveAuthoredSkillsDir, resolveCheckinsFile } from "./personal-providers.js";
import type { MuseEnvironment } from "./index.js";

/**
 * Build the `additionalDetector` closure the followup capture hook
 * uses for its step-5 LLM fallback. Wraps `extractFollowupPromisesLlm`
 * with the per-day budget check so a chatty session can't burn
 * `MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY` calls.
 *
 * Returns `[]` (skip path) when:
 *   - today's call count already meets/exceeds the cap, or
 *   - the LLM detector itself errors / returns nothing.
 *
 * Increments the budget BEFORE the call so even a failed
 * `generate` counts against the cap — we paid for the round-trip
 * regardless. Counter wraparound on date change is handled by the
 * store; no per-call date logic here.
 */
export function createBudgetedLlmDetector(options: {
  readonly modelProvider: ModelProvider;
  readonly model: string;
  readonly budgetFile: string;
  readonly cap: number;
}): (text: string, now: Date) => Promise<readonly Awaited<ReturnType<typeof extractFollowupPromisesLlm>>[number][]> {
  return async (text: string, now: Date) => {
    const today = formatFollowupLlmBudgetDay(now);
    const current = await readFollowupLlmBudget(options.budgetFile);
    if (isFollowupLlmBudgetExhausted(current, today, options.cap)) {
      return [];
    }
    try {
      await incrementFollowupLlmBudget(options.budgetFile, today);
    } catch {
      // Budget bookkeeping failure shouldn't block detection — but
      // we already paid one "logical" call so don't double-charge
      // by also running the LLM if the disk is wedged. Skip.
      return [];
    }
    return extractFollowupPromisesLlm(text, {
      model: options.model,
      modelProvider: options.modelProvider,
      now
    });
  };
}

export interface ReviewArmDeps {
  readonly env: MuseEnvironment;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  readonly userMemoryStore: UserMemoryStore;
}

/**
 * Skill arm of the background-review engine ("hard tasks teach"): when the
 * tool-iteration trigger fires, author a reusable skill from the turn's LIVE
 * conversation. Gated by its OWN flag on top of the engine switch — it writes
 * the skill library unattended (the store's risk-scan quarantines a poisoned
 * draft rather than activating it), so it stays opt-in for a careful rollout.
 */
export function createReviewSkillArm(
  deps: ReviewArmDeps
): ((input: BackgroundReviewInput) => Promise<void>) | undefined {
  const { env, modelProvider, defaultModel } = deps;
  const skillArmOn = parseBoolean(env.MUSE_BACKGROUND_REVIEW_ENABLED, false)
    && parseBoolean(env.MUSE_BACKGROUND_REVIEW_SKILL_ARM, false)
    && Boolean(modelProvider) && Boolean(defaultModel);
  return skillArmOn && modelProvider && defaultModel
    ? async (input: BackgroundReviewInput): Promise<void> => {
      const turns: SessionTurnLine[] = input.context.input.messages
        .filter((m): m is { readonly role: "user" | "assistant"; readonly content: string } =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ content: m.content, role: m.role }));
      if (turns.length === 0) return;
      const store = new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir(env) });
      await reviewSkillsFromTurns(turns, {
        model: defaultModel,
        modelProvider,
        writeDraft: async (draft) => {
          const { action, skill } = await store.writeOrPatch(draft);
          return { action, name: skill.name };
        }
      });
    }
    : undefined;
}

/**
 * Commitment arm: when the engine is on, every surface (incl. the
 * server/daemon, which has no session-end) captures open-loops the user
 * voices and schedules the proactive check-in — deterministic + draft-first,
 * so it rides the engine switch without a separate flag.
 */
export function createReviewCommitmentsArm(
  deps: ReviewArmDeps
): ((input: BackgroundReviewInput) => Promise<void>) | undefined {
  const { env } = deps;
  return parseBoolean(env.MUSE_BACKGROUND_REVIEW_ENABLED, false)
    ? async (input: BackgroundReviewInput): Promise<void> => {
      const userTurns = input.context.input.messages
        .filter((m): m is { readonly role: "user"; readonly content: string } => m.role === "user" && typeof m.content === "string")
        .map((m) => m.content);
      if (userTurns.length === 0) return;
      await scanCommitmentsFromTurns(userTurns, { file: resolveCheckinsFile(env), userId: input.userId });
    }
    : undefined;
}

/**
 * Preference arm: infer style/format/workflow preferences from corrections
 * → the typed user model, on the memory trigger across every surface (the
 * server learns the user's style too, not just CLI session-end). NONE-aware.
 */
export function createReviewPreferencesArm(
  deps: ReviewArmDeps
): ((input: BackgroundReviewInput) => Promise<void>) | undefined {
  const { env, modelProvider, defaultModel, userMemoryStore } = deps;
  return parseBoolean(env.MUSE_BACKGROUND_REVIEW_ENABLED, false) && modelProvider && defaultModel
    ? async (input: BackgroundReviewInput): Promise<void> => {
      const turns: SessionTurnLine[] = input.context.input.messages
        .filter((m): m is { readonly role: "user" | "assistant"; readonly content: string } =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ content: m.content, role: m.role }));
      if (turns.length === 0) return;
      // Feature-detect the typed-slot remover (the file store has it; the abstract
      // UserMemoryStore interface doesn't declare it — same pattern as the optional
      // upsertUserModelSlot).
      const removeSlot = (userMemoryStore as { removeUserModelSlot?: (userId: string, id: string) => unknown }).removeUserModelSlot;
      await inferPreferencesFromTurns(turns, {
        model: defaultModel,
        modelProvider,
        store: {
          upsertUserModelSlot: userMemoryStore.upsertUserModelSlot?.bind(userMemoryStore),
          ...(removeSlot ? { removeUserModelSlot: removeSlot.bind(userMemoryStore) } : {})
        },
        userId: input.userId,
        // Held-out support gate: drop an inferred trait the correction doesn't
        // semantically support (local nomic embedder), so the server never
        // learns a fabricated preference.
        embed: createGateEmbedder(env),
        // Belief-revision supersession (arXiv:2606.09483): read existing prefs so a
        // new one contradicting a stored DIFFERENT-category belief drops the stale one.
        listExistingPreferences: async (userId) =>
          (await userMemoryStore.findByUserId(userId))?.userModel?.preferences?.map((slot) => ({ id: slot.id, value: slot.value })) ?? []
      });
    }
    : undefined;
}
