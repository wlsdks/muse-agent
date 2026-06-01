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

A real preference MUST fit one of those five categories. If the correction is
just a one-off FACTUAL fix (wrong date/time/name/number) or yields only a
vacuous trait ("prefers accurate information", "likes correct answers"), there
is NO durable preference — output exactly: NONE
Examples:
  "no, give me bullet points" → preference: prefers bullet-point answers / category: format
  "no, it's at 4pm" → NONE
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
  // category requirement otherwise).
  if (/\b(accurat|accuracy|correct|precise|precision|truthful|honest|reliab|up-to-date)/iu.test(value)) {
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
  if (!parsed || !options.embed) return parsed;
  const evidence = redact(exchange.correction);
  // The model emits the trait in English even when the user corrected in
  // Korean; nomic-embed-text bridges Hangul/CJK↔Latin weakly (a real Korean
  // correction vs its English trait scores ~0.39, BELOW the supported floor),
  // so a cross-script cosine gate would FALSE-REJECT legitimate bilingual
  // learning. Only apply the semantic gate within a shared script family;
  // across scripts the embedder is out of its validity domain, so fall back to
  // the deterministic regex/category guards already enforced in the parse.
  if (!sharesScriptFamily(evidence, parsed.value)) return parsed;
  // Held-out support gate: the inferred trait must be semantically grounded in
  // the correction that produced it — drop a trait the model conjured that the
  // user's own words don't support. Reuses the merge-coverage gate (symmetric
  // cosine): "is the preference covered by the correction evidence?".
  const verdict = await validateMergeCoverage(
    [{ label: "correction", text: evidence }],
    { label: parsed.value, text: parsed.value },
    { embed: options.embed, floor: options.supportFloor ?? DEFAULT_SUPPORT_FLOOR }
  );
  return verdict.accept ? parsed : undefined;
}

/** True when both strings carry at least one shared script family (Hangul / CJK Han / Latin). */
function sharesScriptFamily(a: string, b: string): boolean {
  const hangul = (s: string): boolean => /[가-힣]/u.test(s);
  const han = (s: string): boolean => /[一-鿿]/u.test(s);
  const latin = (s: string): boolean => /[A-Za-z]{2,}/u.test(s);
  return (hangul(a) && hangul(b)) || (han(a) && han(b)) || (latin(a) && latin(b));
}
