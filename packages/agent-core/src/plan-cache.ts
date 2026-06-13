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

/**
 * AWM (arXiv:2409.07429): only steps from a SUCCESSFUL trajectory become the
 * reusable routine — teaching the model steps that failed their post-condition
 * would propagate bad tool sequences into future plans.
 */
export function selectSuccessfulPlanSteps(
  executed: readonly { readonly step: PlanStep; readonly stepResult: { readonly success: boolean } }[]
): readonly PlanStep[] {
  return executed.filter((record) => record.stepResult.success).map((record) => record.step);
}

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

/**
 * Cosine floor for embedding-based plan reuse — deliberately high-precision:
 * a wrongly reused plan steers the small model's whole tool sequence, so only
 * a near-paraphrase may match semantically. Lexical Jaccard keeps its own
 * lower floor (token overlap is already precise about WHICH words matched).
 */
const DEFAULT_MIN_COSINE = 0.75;

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Embedding-blended plan reuse: Jaccard token overlap misses paraphrases and
 * Korean particle attachment ("회의 일정" vs "미팅 약속"), so score each cached
 * plan on BOTH lexical overlap and embedding cosine and reuse the best
 * candidate that clears either floor. Fail-open per embed call — a down
 * embedder degrades to exactly the lexical selector.
 */
export async function selectPlanExemplarByRelevance(
  entries: readonly CachedPlan[],
  prompt: string,
  embed: (text: string) => Promise<readonly number[]>,
  options?: SelectPlanExemplarOptions & { readonly minCosine?: number }
): Promise<CachedPlan | undefined> {
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const minCosine = options?.minCosine ?? DEFAULT_MIN_COSINE;
  let queryVec: readonly number[] | undefined;
  try {
    queryVec = await embed(prompt);
  } catch {
    queryVec = undefined;
  }
  let best: CachedPlan | undefined;
  let bestScore = 0;
  for (const entry of entries) {
    if (entry.steps.length === 0) {
      continue;
    }
    const lexical = strategyTextSimilarity(prompt, entry.prompt);
    let semantic = 0;
    if (queryVec && queryVec.length > 0) {
      try {
        semantic = cosine(queryVec, await embed(entry.prompt));
      } catch {
        semantic = 0;
      }
    }
    const eligible = lexical >= minScore || semantic >= minCosine;
    const score = Math.max(lexical, semantic);
    if (eligible && score > bestScore) {
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
