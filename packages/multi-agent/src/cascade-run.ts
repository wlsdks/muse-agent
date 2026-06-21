import { shouldEscalateToHeavy, type ModelTier } from "./tiering.js";

/**
 * Cascade EXECUTION (FrugalGPT, arXiv:2305.05176): run the fast model first
 * and accept its answer when confident; escalate to the heavy model only when
 * the fast answer is low-confidence. This is the step that turns the cascade
 * DECISION (`shouldEscalateToHeavy`) into a real compute saving — a confident
 * lookup never pays for the heavy model.
 *
 * Model-agnostic by the package idiom: the caller injects `run` (execute the
 * task on a given model id) and `confidenceOf` (the answer's mean token
 * logprob), so `@muse/multi-agent` never imports a provider. The autoconfigure
 * layer wires the real model-run + `summarizeTokenConfidence` confidence.
 */
export interface CascadeRunArgs<T> {
  readonly fast: string;
  readonly heavy: string;
  readonly run: (model: string) => Promise<T>;
  readonly confidenceOf: (result: T) => number | undefined;
  readonly threshold?: number;
}

export interface CascadeOutcome<T> {
  readonly result: T;
  readonly tier: ModelTier;
  readonly escalated: boolean;
  readonly fastConfidence: number | undefined;
}

/**
 * Bounded to a SINGLE escalation — fast → (maybe) heavy, never a loop (MAST
 * arXiv:2503.13657 'step repetition' / 'unaware of termination' guard). A
 * confident fast answer runs the model exactly ONCE (the latency win); a
 * low-confidence (or unmeasurable, the safe direction) answer runs the heavy
 * model once more and that result wins.
 */
export async function runCascade<T>(args: CascadeRunArgs<T>): Promise<CascadeOutcome<T>> {
  const fastResult = await args.run(args.fast);
  const fastConfidence = args.confidenceOf(fastResult);
  if (!shouldEscalateToHeavy(fastConfidence, args.threshold)) {
    return { escalated: false, fastConfidence, result: fastResult, tier: "fast" };
  }
  const heavyResult = await args.run(args.heavy);
  return { escalated: true, fastConfidence, result: heavyResult, tier: "heavy" };
}
