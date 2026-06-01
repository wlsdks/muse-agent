/**
 * Infer a STABLE persona-level preference from a user correction — the
 * behavior-inferred half of the user model (the rest is taught explicitly via
 * `muse user model add`). Distinct from the playbook distiller
 * ([[correction-distiller]]): that learns a TASK recipe ("when summarising,
 * use bullets"); this learns WHO THE USER IS ("prefers concise, bullet-point
 * answers", category style) — a persona trait that colors every response.
 *
 * The reliable signal is the explicit correction (ReasoningBank, arXiv
 * 2509.25140 — distil from real outcome signals, NOT small-model
 * self-judgement). Returns undefined for a one-off factual fix (no durable
 * preference) so it never fabricates a trait. Fail-soft.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import type { CorrectionExchange } from "./correction-distiller.js";
import { validateMergeCoverage } from "./skill-merge-gate.js";

/**
 * Cosine floor for the held-out SUPPORT gate (SkillOpt propose-and-test): an
 * inferred preference commits only if it is semantically supported by the
 * correction that produced it. Calibrated on nomic-embed-text — a real
 * correction→trait pair scores 0.58–0.73, a one-off factual fix paired with a
 * fabricated trait 0.33–0.38 — so 0.50 sits in the gap, leaning false-negative
 * (drop a weak inference) over a fabricated persona trait, per this module's
 * existing honesty stance.
 */
const DEFAULT_SUPPORT_FLOOR = 0.5;

export interface InferredPreference {
  /** Short trait, e.g. "prefers concise, bullet-point answers". */
  readonly value: string;
  /** Optional category: style / format / language / tooling / workflow. */
  readonly category?: string;
  /** 0..1 confidence. */
  readonly confidence: number;
}

export interface InferPreferenceOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * Embed text to a vector (the local nomic embedder). When provided, the
   * inferred preference must be semantically SUPPORTED by the correction it was
   * drawn from (cosine ≥ `supportFloor`), else it is dropped — a held-out gate
   * against the model fabricating a trait unrelated to what the user said.
   * Fail-closed: an embedding error drops the inference. Omitted ⇒ no gate.
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /** Cosine floor for the support gate. Default 0.50. */
  readonly supportFloor?: number;
}

const PREFERENCE_CATEGORIES = ["style", "format", "language", "tooling", "workflow"] as const;

const PREFERENCE_SYSTEM_PROMPT =
  `The user just CORRECTED the assistant. Infer the STABLE personal PREFERENCE
behind it — how this user likes things in general (communication style, output
format, language, tooling, workflow) — NOT a one-task instruction. Output
exactly:
preference: <one short trait, e.g. "prefers concise, bullet-point answers">
category: <EXACTLY one of: style | format | language | tooling | workflow>
confidence: <0.0-1.0, how durable this preference seems>

A real preference is about HOW the user likes things (style/format), NEVER about
the specific FACT being corrected. If the correction just fixes a wrong
date/time/name/number/place — restating or insisting on the right value — there
is NO durable preference: output exactly NONE. Do NOT turn "it's 4pm not 3pm"
into "prefers being told the correct time" or "should say 4 o'clock"; that is
the fact, not a preference. A vacuous trait ("prefers accurate information",
"정확하게 말하기를 선호") is likewise NONE.
IMPORTANT: write the preference value in the SAME LANGUAGE the user wrote their
correction in — if their correction is in English, answer in English; if in
Korean, answer in Korean — so it can be verified against what they actually
said. (The category stays one of the five English words above.)
Examples:
  "no, give me bullet points" → preference: prefers bullet-point answers / category: format
  "no, it's at 4pm" → NONE
  "그게 아니라 짧게 핵심만" → preference: 간결하게 핵심만 답하기를 선호 / category: format
  "아니 4시야" → NONE
No preamble, no markdown, no quotes.`;

export function parseInferredPreference(raw: string): InferredPreference | undefined {
  const text = raw.trim();
  if (/^NONE\b/iu.test(text)) return undefined;
  const value = /preference:\s*(.+)/iu.exec(text)?.[1]?.trim();
  if (!value || value.length < 2) return undefined;
  // Vacuous-trait guard: a one-off factual fix makes the small model fabricate
  // "prefers accurate information" / "correct answers" — things EVERY user
  // wants, not a preference. Reject the accuracy/correctness cluster outright
  // (proven necessary by the live negative case; the model games the
  // category requirement otherwise). Korean terms are included because the
  // language-mirrored output emits the same vacuous trait in Korean (정확/정밀/
  // 올바르 = accurate/precise/correct) which the English alternation misses.
  if (/\b(accurat|accuracy|correct|precise|precision|truthful|honest|reliab|up-to-date)/iu.test(value)
    || /(정확|정밀|올바르|올바른|사실대로|틀리지|맞게\s*말|정직)/u.test(value)) {
    return undefined;
  }
  // Require a VALID category. The small model fabricates a vacuous trait
  // ("prefers accurate information") with NO category on a one-off factual
  // fix; demanding one of the five real categories deterministically rejects
  // that (proven by the live negative case) — lean false-negative over a
  // fabricated persona trait.
  const categoryRaw = /category:\s*([a-z]+)/iu.exec(text)?.[1]?.trim().toLowerCase();
  if (!categoryRaw || !(PREFERENCE_CATEGORIES as readonly string[]).includes(categoryRaw)) return undefined;
  const confRaw = /confidence:\s*([0-9]*\.?[0-9]+)/iu.exec(text)?.[1];
  const parsed = confRaw !== undefined ? Number(confRaw) : 0.6;
  const confidence = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.6;
  return { category: categoryRaw, confidence, value };
}

export async function inferPreferenceFromCorrection(
  exchange: CorrectionExchange,
  options: InferPreferenceOptions
): Promise<InferredPreference | undefined> {
  const redact = options.redact ?? redactSecretsInText;
  const transcript = [
    exchange.request ? `user asked: ${redact(exchange.request)}` : undefined,
    `assistant answered: ${redact(exchange.priorAnswer)}`,
    `user corrected: ${redact(exchange.correction)}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  const messages: readonly ModelMessage[] = [
    { content: PREFERENCE_SYSTEM_PROMPT, role: "system" },
    { content: transcript, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 80,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };
  let output: string;
  try {
    output = (await options.modelProvider.generate(request)).output?.trim() ?? "";
  } catch {
    return undefined;
  }
  const parsed = parseInferredPreference(output);
  if (!parsed) return undefined;
  // Fact-restatement guard (deterministic, language-neutral): a date/time/
  // number/quantity correction makes the small model echo the corrected VALUE
  // as a fake preference ("prefers saying 4 o'clock" / "4시라고 말하기를 선호").
  // If the trait repeats a number that appears in the correction, it is
  // restating the fact, not abstracting a HOW-preference — drop it. Catches the
  // factual-fix class the English NONE rule handles but the model's Korean
  // reasoning does not; leans false-negative, per this module's stance.
  const correctionNums = new Set(redact(exchange.correction).match(/\d+/gu) ?? []);
  if (correctionNums.size > 0 && (parsed.value.match(/\d+/gu) ?? []).some((n) => correctionNums.has(n))) {
    return undefined;
  }
  if (!options.embed) return parsed;
  // Held-out support gate: the inferred trait must be semantically grounded in
  // the correction that produced it — drop a trait the model conjured that the
  // user's own words don't support. Reuses the merge-coverage gate (symmetric
  // cosine): "is the preference covered by the correction evidence?". The gate
  // itself skips cross-script pairs (the model emits the trait in English even
  // for a Korean correction, which nomic bridges weakly), so legitimate
  // bilingual learning is not false-rejected — see comparableScript.
  const verdict = await validateMergeCoverage(
    [{ label: "correction", text: redact(exchange.correction) }],
    { label: parsed.value, text: parsed.value },
    { embed: options.embed, floor: options.supportFloor ?? DEFAULT_SUPPORT_FLOOR }
  );
  return verdict.accept ? parsed : undefined;
}
