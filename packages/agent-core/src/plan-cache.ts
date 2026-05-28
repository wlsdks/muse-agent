/**
 * Agentic Plan Caching (arXiv 2506.14852): an agent extracts plan templates
 * from completed runs and reuses them on semantically-similar later tasks.
 *
 * Muse runs a small LOCAL model, so the paper's headline (cloud cost −50%)
 * doesn't apply — instead the cached plan is injected into the planning prompt
 * as a few-shot EXEMPLAR so the small model produces a better one-shot plan
 * (`tool-calling.md`: make the first call correct). Deterministic token-overlap
 * retrieval, no extra model round, no migration; the durable store lives in
 * `@muse/mcp` and is adapted to the duck-typed `PlanCacheProvider` below.
 */

import { strategyTextSimilarity } from "./playbook.js";
import type { PlanStep } from "./plan-execute.js";
import type { Awaitable } from "./types.js";

export interface CachedPlan {
  readonly prompt: string;
  readonly steps: readonly PlanStep[];
}

export interface PlanCacheProvider {
  findSimilarPlan(userId: string, prompt: string): Awaitable<CachedPlan | undefined>;
  recordPlan(userId: string, prompt: string, steps: readonly PlanStep[]): Awaitable<void>;
}

export interface SelectPlanExemplarOptions {
  /** Minimum prompt-similarity (Jaccard token overlap) to reuse a past plan. Default 0.3. */
  readonly minScore?: number;
}

const DEFAULT_MIN_SCORE = 0.3;

export function selectPlanExemplar(
  entries: readonly CachedPlan[],
  prompt: string,
  options?: SelectPlanExemplarOptions
): CachedPlan | undefined {
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  let best: CachedPlan | undefined;
  let bestScore = minScore;
  for (const entry of entries) {
    if (entry.steps.length === 0) {
      continue;
    }
    const score = strategyTextSimilarity(prompt, entry.prompt);
    if (score >= bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

const MAX_EXEMPLAR_CHARS = 800;

export function renderPlanExemplar(plan: CachedPlan): string {
  const steps = plan.steps.map((step) => ({
    args: step.args,
    description: step.description,
    tool: step.tool
  }));
  const prompt = plan.prompt.replace(/\s+/gu, " ").trim();
  const body = `요청: "${prompt}"\n계획: ${JSON.stringify(steps)}`;
  // Cap so a long past plan can't blow the small model's planning context.
  return body.length > MAX_EXEMPLAR_CHARS ? `${body.slice(0, MAX_EXEMPLAR_CHARS)}…` : body;
}
