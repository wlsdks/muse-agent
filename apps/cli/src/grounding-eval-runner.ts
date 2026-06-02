import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  rankKnowledgeChunks,
  REVERIFY_SYSTEM_PROMPT,
  scoreGroundingEval,
  verifyGroundingWithReverify
} from "@muse/agent-core";
import type { GroundingEvalCorpus, GroundingEvalResult, GroundingReverify } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";

export interface GroundingThresholds {
  /** Faithfulness (fabrication caught) must be at or above this to pass. */
  readonly minFaithfulness: number;
  /** False-refusal (in-corpus answer wrongly refused) must be at or below this to pass. */
  readonly maxFalseRefusal: number;
}

/**
 * Shipped pass/fail bar — a REGRESSION FLOOR, set one miss below the live
 * baseline the honest current gate clears on the bundled corpus (measured
 * deterministically at faithfulness 0.92 = 12/13 caught, false-refusal 0.08 =
 * 1/12, on nomic-embed-text + qwen3:8b). The single uncaught case is the
 * compressed-cosine near-miss reranking/calibration will fix — so faithfulness
 * has headroom toward 1.0 and this floor rises as those land.
 */
export const GROUNDING_THRESHOLDS: GroundingThresholds = {
  maxFalseRefusal: 0.25,
  minFaithfulness: 0.84
};

export interface RunGroundingEvalDeps {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly reverify: GroundingReverify;
  readonly topK?: number;
}

/** Wire the pure scorer to the REAL recall + RGV stack (live embeddings + weak-band judge). */
export function runGroundingEval(corpus: GroundingEvalCorpus, deps: RunGroundingEvalDeps): Promise<GroundingEvalResult> {
  const topK = deps.topK ?? 4;
  return scoreGroundingEval(corpus, {
    rank: (query) => rankKnowledgeChunks(query, corpus.notes, { diversify: true, embed: deps.embed, hybrid: true, topK }),
    verify: (answer, matches, query) => verifyGroundingWithReverify(answer, matches, query, deps.reverify)
  });
}

/** The one-shot local-Qwen grounding judge the weak band spends a second inference on. */
export function createQwenReverify(modelProvider: ModelProvider, model: string): GroundingReverify {
  return async ({ answer, evidence, query }) => {
    const response = await modelProvider.generate({
      maxOutputTokens: 8,
      messages: [
        { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
        { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
      ],
      model,
      temperature: 0
    });
    return parseGroundingReverifyVerdict(response.output ?? "");
  };
}

export interface GroundingReport {
  readonly status: "ok" | "fail";
  readonly text: string;
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/** Pure render of the two rates + failing cases, with the pass/fail verdict — testable without Ollama. */
export function renderGroundingEvalReport(result: GroundingEvalResult, thresholds: GroundingThresholds): GroundingReport {
  const faithOk = result.faithfulnessRate >= thresholds.minFaithfulness;
  const refuseOk = result.falseRefusalRate <= thresholds.maxFalseRefusal;
  const lines = [
    `grounding edge — ${result.total.toString()} cases (${result.answerable.toString()} answerable, ${result.refuse.toString()} must-refuse, ${result.drift.toString()} drift):`,
    `  faithfulness   ${result.faithfulnessRate.toFixed(2)}  (${result.caught.toString()}/${result.guardable.toString()} unfaithful answers caught)  ${faithOk ? "✓" : `✗ below ${pct(thresholds.minFaithfulness)}`}`,
    `  false-refusal  ${result.falseRefusalRate.toFixed(2)}  (${result.falseRefusals.toString()}/${result.answerable.toString()} in-corpus answers wrongly refused)  ${refuseOk ? "✓" : `✗ above ${pct(thresholds.maxFalseRefusal)}`}`
  ];
  const failing = result.outcomes.filter((outcome) => !outcome.passed);
  if (failing.length > 0) {
    lines.push("  flagged cases:");
    for (const outcome of failing) {
      lines.push(`    · [${outcome.kind}] "${outcome.query}" — ${outcome.detail}${outcome.note ? ` (${outcome.note})` : ""}`);
    }
  }
  return { status: faithOk && refuseOk ? "ok" : "fail", text: lines.join("\n") };
}
