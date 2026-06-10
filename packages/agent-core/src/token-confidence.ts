import type { TokenLogprob } from "@muse/model";

/**
 * Deterministic confidence features from observational token logprobs
 * (Ollama ≥0.30.6): the model-internal axis orthogonal to retrieval
 * similarity. `minLogprob` is the classic weakest-claim signal; perplexity
 * is exp(−mean). Channel-marker tokens (gemma4 emits `<|channel>`-style
 * scaffolding) carry no content and are excluded from scoring.
 */
export interface TokenConfidenceSummary {
  readonly meanLogprob: number;
  readonly minLogprob: number;
  readonly perplexity: number;
  readonly scoredTokens: number;
}

export function summarizeTokenConfidence(
  entries: readonly TokenLogprob[]
): TokenConfidenceSummary | undefined {
  const scored = entries.filter((entry) => !entry.token.startsWith("<|"));
  if (scored.length === 0) {
    return undefined;
  }
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const entry of scored) {
    sum += entry.logprob;
    if (entry.logprob < min) {
      min = entry.logprob;
    }
  }
  const mean = sum / scored.length;
  return { meanLogprob: mean, minLogprob: min, perplexity: Math.exp(-mean), scoredTokens: scored.length };
}
