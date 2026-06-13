/**
 * Grounded reflection synthesis — Muse's take on the "dreaming" / offline memory
 * consolidation that competitors (OpenClaw) lean on, adapted from Generative
 * Agents' reflection step (Park et al. 2023, arXiv:2304.03442): periodically
 * synthesise many low-level observations into a few higher-level insights.
 *
 * The MUSE twist is the identity ("Tell it everything. It can't tell anyone." —
 * honest, never makes things up): a reflection is only kept if it is GROUNDED in
 * the user's actual episodes/notes. Each reflection must cite the source ids it
 * was synthesised from; `parseReflections` deterministically strips any cited id
 * that wasn't in the input (the model cannot invent a source) and drops a
 * reflection that ends up under-supported. So Muse "dreams" about your life, but
 * every insight points back to where it came from — no confabulated self-model.
 *
 * Pure (`buildReflectionUserMessage`, `parseReflections`) + a thin model-driven
 * `synthesizeReflections`, mirroring `preference-inference` / `pattern-suggestion`.
 */

import type { ModelMessage, ModelProvider, ModelRequest } from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import { type GroundingReverify, judgeConsensus } from "./knowledge-recall.js";
import { extractJsonArray } from "./plan-execute.js";

export interface ReflectionInput {
  /** Stable id of the source (an episode id, a note path, …). */
  readonly id: string;
  /** Its summary / content the reflection may draw on. */
  readonly text: string;
}

export interface Reflection {
  /** The higher-level insight about the user (a recurring theme, a stable preference, an open thread). */
  readonly insight: string;
  /** The input ids this insight is grounded in — always a subset of the provided inputs. */
  readonly sourceIds: readonly string[];
  /** Count of distinct grounding sources (≥ minSupport). */
  readonly supportCount: number;
}

export interface SynthesizeReflectionsOptions {
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly model: string;
  /** Cap on reflections returned. Default 5. */
  readonly maxReflections?: number;
  /** Minimum distinct grounding sources for a reflection to survive. Default 2. */
  readonly minSupport?: number;
  readonly redact?: (text: string) => string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /**
   * Optional RGV re-verification (slice 4): after a reflection passes the
   * id-citation gate, an injected judge re-checks that its insight is genuinely
   * supported by the TEXT of its cited sources — dropping a confabulated insight
   * that cites real-but-unrelated episodes. Omitted ⇒ id-gate only (back-compat).
   */
  readonly reverify?: GroundingReverify;
  /**
   * k judge samples per reflection (self-consistency, arXiv:2203.11171). >1
   * collapses k verdicts unanimously (one NO drops the reflection) so a single
   * flaky YES can't promote a confabulated "dream" — parity with recall's
   * `reverifySamples`. Clamped to [1,5]. Default 1 (single judge, back-compat).
   */
  readonly reverifySamples?: number;
}

const DEFAULT_MAX_REFLECTIONS = 5;
const DEFAULT_MIN_SUPPORT = 2;

const REFLECTION_SYSTEM_PROMPT =
  "You are Muse, reflecting privately over the user's own recent episodes and notes to consolidate memory. " +
  "Synthesise a FEW higher-level insights about the user — recurring themes, stable preferences, or open threads — " +
  "that span MULTIPLE of the provided items. Each item is labelled with an [id]. " +
  "Output ONLY a JSON array. Each element is an object with two fields: " +
  "\"insight\" (one concise sentence) and \"sources\" (an array of the [id] strings the insight is drawn from, at least two). " +
  "HARD RULES: cite ONLY ids that appear in the provided items — never invent an id; " +
  "synthesise ONLY what genuinely recurs across multiple items — do not infer beyond the text; " +
  "if nothing recurs across two or more items, output an empty array []. No prose outside the JSON.";

/** Render the inputs as an `[id] text` list the model reflects over. */
export function buildReflectionUserMessage(
  inputs: readonly ReflectionInput[],
  redact: (text: string) => string = redactSecretsInText
): string {
  const lines = inputs.map((item) => `[${item.id}] ${redact(item.text).replace(/\s+/gu, " ").trim()}`);
  return `Recent items:\n${lines.join("\n")}`;
}

interface RawReflection {
  readonly insight?: unknown;
  readonly sources?: unknown;
}

/**
 * Parse + GROUND the model's JSON. For each reflection: keep only cited ids that
 * are real input ids (no invented sources), drop it if it ends up with fewer
 * than `minSupport` distinct sources or an empty insight, and cap the result.
 * Pure + exported for direct unit coverage.
 */
export function parseReflections(
  raw: string,
  validIds: ReadonlySet<string>,
  options: { readonly maxReflections?: number; readonly minSupport?: number } = {}
): Reflection[] {
  const maxReflections = Math.max(1, Math.trunc(options.maxReflections ?? DEFAULT_MAX_REFLECTIONS));
  const minSupport = Math.max(1, Math.trunc(options.minSupport ?? DEFAULT_MIN_SUPPORT));
  const jsonText = extractJsonArray(raw);
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Reflection[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { insight, sources } = entry as RawReflection;
    if (typeof insight !== "string" || insight.trim().length === 0) continue;
    if (!Array.isArray(sources)) continue;
    // Honesty guard: keep only real, distinct source ids — the model cannot
    // ground an insight in a source the user doesn't actually have.
    const grounded = [...new Set(sources.filter((s): s is string => typeof s === "string" && validIds.has(s)))];
    if (grounded.length < minSupport) continue;
    out.push({ insight: insight.trim(), sourceIds: grounded, supportCount: grounded.length });
    if (out.length >= maxReflections) break;
  }
  return out;
}

/**
 * Synthesise grounded reflections from recent items via the local model.
 * Returns [] when there isn't enough to reflect on, on any model error, or when
 * nothing grounded survives. Fail-soft — reflection is a background nicety, never
 * a blocking path.
 */
export async function synthesizeReflections(
  inputs: readonly ReflectionInput[],
  options: SynthesizeReflectionsOptions
): Promise<Reflection[]> {
  const minSupport = Math.max(1, Math.trunc(options.minSupport ?? DEFAULT_MIN_SUPPORT));
  // Need at least `minSupport` items before any cross-item theme is possible.
  const usable = inputs.filter((i) => i.id.length > 0 && i.text.trim().length > 0);
  if (usable.length < minSupport) return [];

  const redact = options.redact ?? redactSecretsInText;
  const messages: readonly ModelMessage[] = [
    { content: REFLECTION_SYSTEM_PROMPT, role: "system" },
    { content: buildReflectionUserMessage(usable, redact), role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 400,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.4
  };
  let output: string;
  try {
    output = (await options.modelProvider.generate(request)).output?.trim() ?? "";
  } catch {
    return [];
  }
  const reflections = parseReflections(output, new Set(usable.map((i) => i.id)), {
    ...(options.maxReflections !== undefined ? { maxReflections: options.maxReflections } : {}),
    minSupport
  });
  if (!options.reverify) return reflections;
  const sources = new Map(usable.map((i) => [i.id, i.text]));
  return verifyReflectionsGrounding(reflections, sources, options.reverify, options.reverifySamples);
}

export const REFLECTION_GROUNDING_QUERY = "What genuinely recurs about this user across these items?";

/**
 * RGV re-verification for the reflection surface: keep a reflection ONLY when
 * the injected judge confirms its insight is supported by the TEXT of its cited
 * sources. Reflections are abstractions (lexical coverage misfits them), so the
 * one-shot judge — not the rubric — is the right tool. Fail-close: a judge that
 * returns false OR throws drops the reflection (a "dream" never survives an
 * unverifiable check). Pure over the injected judge + exported for direct coverage.
 */
export async function verifyReflectionsGrounding(
  reflections: readonly Reflection[],
  sources: ReadonlyMap<string, string>,
  reverify: GroundingReverify,
  reverifySamples?: number
): Promise<Reflection[]> {
  const kept: Reflection[] = [];
  const samples = Math.min(5, Math.max(1, reverifySamples ?? 1));
  for (const reflection of reflections) {
    const evidence = reflection.sourceIds
      .map((id) => sources.get(id))
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("\n");
    // No cited source resolved ⇒ empty evidence ⇒ unverifiable. The judge is the
    // only gate here (no deterministic rubric pre-gate), so a YES on "" would leak
    // a baseless "dream". Fail-close WITHOUT consulting the judge.
    if (evidence.trim().length === 0) {
      continue;
    }
    let supported: boolean;
    try {
      // Collect up to k verdicts, short-circuiting on first NO (unanimous-pass):
      // one dissent drops the reflection, so a single flaky YES can't promote a
      // confabulated insight (single-judge intra-rater variance).
      const verdicts: boolean[] = [];
      for (let i = 0; i < samples; i++) {
        const v = await reverify({ answer: reflection.insight, evidence, query: REFLECTION_GROUNDING_QUERY });
        verdicts.push(v);
        if (!v) break;
      }
      supported = judgeConsensus(verdicts, "unanimous-pass");
    } catch {
      supported = false;
    }
    if (supported) kept.push(reflection);
  }
  return kept;
}
