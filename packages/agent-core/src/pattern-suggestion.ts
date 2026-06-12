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

const SUGGESTION_SYSTEM_PROMPT =
  `You are Muse, a JARVIS-style personal assistant. You noticed a RECURRING
pattern in the user's own behavior and want to OFFER to help before being
asked. Write ONE short, warm, first-person offer (one sentence, ≤ 160 chars)
grounded STRICTLY in the facts given — name the real recurring thing and offer
the next useful step. Rules:
- Use ONLY the given facts. Invent NOTHING (no times/names/details not stated).
- It's an OFFER, not an action ("…할까요?" / "want me to …?"), never "I did".
- If the facts are too thin to make a genuinely useful, specific offer, output
  exactly: NONE
No preamble, no markdown, no quotes.`;

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
  return output;
}
