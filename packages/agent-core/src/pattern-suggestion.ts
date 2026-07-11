/**
 * Compose a warm, GROUNDED proactive suggestion from a detected behavior
 * pattern. The pattern detector (`@muse/memory`) finds a recurring cluster and
 * ships a flat `suggestion` string; this rephrases it into one natural,
 * specific first-person offer ("월요일 아침마다 보고서를 손보시던데, 지금 초안
 * 잡아둘까요?") using ONLY the grounded facts — and returns undefined (→ the
 * caller keeps the verbatim fallback, or stays silent) when the model declines
 * or the facts are too thin. The whole risk of small-model suggestion is
 * FABRICATION, so the prompt forbids inventing anything not in the facts and
 * the negative path is first-class.
 *
 * This is the deferred "Phase D synthesis" the pattern-firing loop flagged.
 * Behavior→anticipatory suggestion is greenfield (neither Hermes nor OpenClaw
 * predicts from behavior) — Muse's own design.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { composeSurfacePrompt } from "@muse/prompts";
import { redactSecretsInText } from "@muse/shared";

export interface PatternSuggestionInput {
  /** Detector category, e.g. "weekly-task" / "time-of-day-action". */
  readonly category: string;
  /** 0..1 detector confidence. */
  readonly confidence: number;
  /** The detector's flat suggestion — the fallback if synthesis declines. */
  readonly fallbackSuggestion: string;
  /** Rendered grounded facts (the cluster's real weekday/action/counts). */
  readonly groundedFacts: string;
}

export interface SynthesizePatternSuggestionOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

const SUGGESTION_SYSTEM_PROMPT = composeSurfacePrompt("patternSuggestion", {});

// The detector's fallback suggestion always carries a "(N edits across M
// days)" / "(N times across M weeks)" why-now clause (pattern-detector.ts's
// buildMatch / buildWeeklyTaskMatch) — the two counts that ground the offer.
const EVIDENCE_CLAUSE_PATTERN = /\((\d+) (?:edits|times) across (\d+) (?:days|weeks)\)/u;

function containsCount(text: string, count: string): boolean {
  return new RegExp(`(?<!\\d)${count}(?!\\d)`, "u").test(text);
}

export async function synthesizePatternSuggestion(
  input: PatternSuggestionInput,
  options: SynthesizePatternSuggestionOptions
): Promise<string | undefined> {
  const redact = options.redact ?? redactSecretsInText;
  const body = [
    `pattern: ${input.category} (confidence ${input.confidence.toFixed(2)})`,
    `facts: ${redact(input.groundedFacts)}`,
    `detector's draft suggestion: ${redact(input.fallbackSuggestion)}`
  ].join("\n");
  const messages: readonly ModelMessage[] = [
    { content: SUGGESTION_SYSTEM_PROMPT, role: "system" },
    { content: body, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 80,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };
  let output: string;
  try {
    const response = await options.modelProvider.generate(request);
    output = (response.output ?? "").trim();
  } catch {
    return undefined;
  }
  if (output.length === 0 || /^NONE\b/iu.test(output)) return undefined;
  // Deterministic anti-fabrication (the documented core risk): an unasked OFFER
  // that asserts a NUMBER — a time, count, or date — absent from the grounded
  // facts is invented ("draft before your 3pm meeting" when no 3pm is in the
  // facts). The prompt forbids it, but a prompt is not a guarantee on an 8B
  // (tool-calling.md), so drop such an offer and let the caller keep the
  // verbatim detector fallback. Mirrors the correction-distiller number guard;
  // language-neutral. The facts carry the real weekday/action/counts, so a
  // genuine count echoed back is in `factNums` and survives.
  const factNums = new Set(redact(input.groundedFacts).match(/\d+/gu) ?? []);
  if ((output.match(/\d+/gu) ?? []).some((n) => !factNums.has(n))) {
    return undefined;
  }
  // Anti-fabrication only guards WRONG numbers, not a MISSING why-now clause
  // — a fluent paraphrase can drop the evidence entirely. Never reject the
  // synthesis for that; append the fallback's own clause verbatim (the exact
  // numbers, no re-derivation) when the composed prose doesn't already carry
  // both counts.
  const evidenceClause = input.fallbackSuggestion.match(EVIDENCE_CLAUSE_PATTERN);
  if (evidenceClause) {
    const [clause, editCount, dayCount] = evidenceClause;
    const hasEvidence = containsCount(output, editCount!) && containsCount(output, dayCount!);
    if (!hasEvidence) {
      return `${output} ${clause}`;
    }
  }
  return output;
}
