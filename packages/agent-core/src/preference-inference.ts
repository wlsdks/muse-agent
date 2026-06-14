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

import { classifyCorrectionContradiction, type ClassifyContradictionOptions, type CorrectionExchange } from "./correction-distiller.js";
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
  /**
   * DINCO confidence calibration (arXiv:2509.25532): when true, recalibrate the
   * model's raw verbalized `confidence` against self-generated incompatible
   * distractor traits — a trait that doesn't dominate its alternatives is dropped,
   * and a surviving trait's confidence is the distractor-normalized (less
   * saturated) value. Opt-in (the production caller sets it); fail-soft (a model
   * error keeps the raw confidence). One extra model call per accepted inference.
   */
  readonly calibrateConfidence?: boolean;
  /** Floor the distractor-normalized confidence must clear to survive. Default 0.34 (beats a uniform 1-of-3 split). */
  readonly distractorFloor?: number;
}

/**
 * Floor a distractor-normalized confidence must clear to keep the trait. 0.34 ≈
 * one-third + ε: a trait that doesn't beat an even split across its 3 distractors
 * is no more supported than a guess, so it's dropped (DINCO arXiv:2509.25532).
 */
export const DEFAULT_PREFERENCE_DISTRACTOR_FLOOR = 0.34;

const CALIBRATION_SYSTEM_PROMPT =
  `You validate an inferred user PREFERENCE against the correction it came from.
Given the user's correction and a candidate preference TRAIT:
1. Invent 3 INCOMPATIBLE alternative traits — different preferences the user might
   plausibly hold INSTEAD on the same dimension (style / format / length / tone) —
   in the SAME LANGUAGE as the correction.
2. Independently rate, 0.0-1.0, how strongly the CORRECTION supports EACH trait
   (the candidate first, then your 3 alternatives). Rate each on its own merits.
Output EXACTLY four lines, nothing else:
original: <0.0-1.0>
alt1: <0.0-1.0>
alt2: <0.0-1.0>
alt3: <0.0-1.0>`;

function parseConfidenceLine(text: string, label: string): number | undefined {
  const m = new RegExp(`${label}:\\s*([0-9]*\\.?[0-9]+)`, "iu").exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
}

/**
 * DINCO distractor-normalized confidence (arXiv:2509.25532, Wang & Stengel-Eskin,
 * ICLR 2026): a verbalized confidence is suggestible/saturated, so normalize it by
 * the model's confidence on self-generated INCOMPATIBLE alternatives —
 * `cal = c(orig) / (c(orig) + Σ c(distractors))`. A trait that doesn't dominate its
 * own distractors is unreliable → returns undefined (drop). Fail-soft: a model
 * error or unparseable response returns `rawConfidence` (today's behaviour, no drop).
 */
export async function calibratePreferenceConfidence(
  correction: string,
  trait: string,
  rawConfidence: number,
  options: {
    readonly modelProvider: Pick<ModelProvider, "generate">;
    readonly model: string;
    readonly distractorFloor?: number;
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  }
): Promise<number | undefined> {
  const messages: readonly ModelMessage[] = [
    { content: CALIBRATION_SYSTEM_PROMPT, role: "system" },
    { content: `correction: ${correction}\ncandidate trait: ${trait}`, role: "user" }
  ];
  let output: string;
  try {
    output = (await options.modelProvider.generate({
      maxOutputTokens: options.maxOutputTokens ?? 60,
      messages,
      model: options.model,
      temperature: options.temperature ?? 0
    })).output?.trim() ?? "";
  } catch {
    return rawConfidence; // fail-soft: keep the raw confidence, never drop on error
  }
  const orig = parseConfidenceLine(output, "original");
  const d1 = parseConfidenceLine(output, "alt1");
  const d2 = parseConfidenceLine(output, "alt2");
  const d3 = parseConfidenceLine(output, "alt3");
  if (orig === undefined || d1 === undefined || d2 === undefined || d3 === undefined) {
    return rawConfidence; // unparseable → fail-soft keep
  }
  const denom = orig + d1 + d2 + d3;
  if (denom <= 0) return rawConfidence;
  const calibrated = orig / denom;
  const floor = options.distractorFloor ?? DEFAULT_PREFERENCE_DISTRACTOR_FLOOR;
  return calibrated >= floor ? calibrated : undefined;
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
  // Held-out support gate: the inferred trait must be semantically grounded in
  // the correction that produced it — drop a trait the model conjured that the
  // user's own words don't support. Reuses the merge-coverage gate (symmetric
  // cosine): "is the preference covered by the correction evidence?". The gate
  // itself skips cross-script pairs (the model emits the trait in English even
  // for a Korean correction, which nomic bridges weakly), so legitimate
  // bilingual learning is not false-rejected — see comparableScript.
  if (options.embed) {
    const verdict = await validateMergeCoverage(
      [{ label: "correction", text: redact(exchange.correction) }],
      { label: parsed.value, text: parsed.value },
      { embed: options.embed, floor: options.supportFloor ?? DEFAULT_SUPPORT_FLOOR }
    );
    if (!verdict.accept) return undefined;
  }
  // DINCO calibration (arXiv:2509.25532): recalibrate the model's raw verbalized
  // confidence against self-generated distractor traits — a trait that doesn't
  // dominate its alternatives is dropped, else its confidence is the less-saturated
  // normalized value. Applied AFTER the accept gates so the extra model call runs
  // only on a trait already worth persisting.
  if (options.calibrateConfidence) {
    const calibrated = await calibratePreferenceConfidence(
      redact(exchange.correction),
      parsed.value,
      parsed.confidence,
      {
        model: options.model,
        modelProvider: options.modelProvider,
        ...(options.distractorFloor !== undefined ? { distractorFloor: options.distractorFloor } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {})
      }
    );
    if (calibrated === undefined) return undefined;
    return { ...parsed, confidence: calibrated };
  }
  return parsed;
}

/** Default cap on contradiction classifications per newly-inferred preference. */
export const DEFAULT_PREFERENCE_SUPERSEDE_MAX = 6;

export interface ExistingPreferenceForSupersede {
  /** The stored slot's id (the upsert key — never the one being written this turn). */
  readonly id: string;
  /** The stored preference text the new one is checked against. */
  readonly value: string;
}

/**
 * Belief-revision supersession for inferred preferences (arXiv:2606.09483 —
 * "Memory Beyond Recall": record belief revisions as supersedes chains, don't let
 * stale beliefs accumulate). The upsert already supersedes a SAME-category
 * preference by id (`pref-<category>`), but a contradictory preference filed under
 * a DIFFERENT category (stored `format`="answer in bullet points", later inferred
 * `style`="write in flowing prose") escapes that key and BOTH inject into every
 * system prompt — handing the small local model contradictory persona guidance.
 *
 * This identifies an existing preference (of a different id) that the NEW one
 * CONTRADICTS, so the caller can drop the stale belief (newer wins). It reuses the
 * proven model-polarity primitive `classifyCorrectionContradiction` — NOT cosine,
 * because same-topic OPPOSITE-polarity preferences have HIGH cosine (the
 * cumulative lesson: similarity ≠ contradiction; polarity needs an NLI/model call).
 * FAIL-OPEN: only a confident "contradict" supersedes; "agree"/"unrelated"/
 * "uncertain"/error leave both (today's accumulate behavior). Bounded model spend
 * (≤ `maxClassifications`). Returns the superseded slot's id, or undefined.
 */
export async function findSupersededPreferenceId(
  newPreferenceValue: string,
  newPreferenceId: string,
  existing: readonly ExistingPreferenceForSupersede[],
  options: ClassifyContradictionOptions & { readonly maxClassifications?: number }
): Promise<string | undefined> {
  if (newPreferenceValue.trim().length === 0 || existing.length === 0) return undefined;
  const cap = Math.max(1, Math.trunc(options.maxClassifications ?? DEFAULT_PREFERENCE_SUPERSEDE_MAX));
  let checked = 0;
  for (const slot of existing) {
    // The same-category slot is already superseded by id; never supersede self.
    if (slot.id === newPreferenceId || slot.value.trim().length === 0) continue;
    if (checked >= cap) break;
    checked += 1;
    const polarity = await classifyCorrectionContradiction(newPreferenceValue, slot.value, options);
    if (polarity === "contradict") return slot.id;
  }
  return undefined;
}
