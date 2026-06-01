/**
 * Held-out validation gate for the curator skill-merge — Muse's adaptation of
 * SkillOpt (Microsoft, MIT, arXiv 2605.23904): turn self-editing into
 * propose-and-test. The merger PROPOSES an umbrella; this gate TESTS it before
 * the store commits, so a destructive merge that silently drops one of the
 * cluster's skills is rejected and rolled back instead of overwriting.
 *
 * The held-out criterion for a CONSOLIDATION is no coverage regression: each
 * original skill's purpose must still be reachable through the umbrella. The
 * check is SEMANTIC, not lexical — a good consolidation GENERALISES (three
 * "summarise-email / -doc / -notes" skills become one "summarise content"), so
 * a lexical "must echo each skill's words" test false-rejects exactly the
 * behaviour we want. We embed each original's trigger (name + "Use when …"
 * description) and the umbrella's, and require cosine ≥ `floor`. Calibrated on
 * nomic-embed-text: a real generalised umbrella scores 0.76–0.84 against its
 * originals, an off-topic umbrella 0.51–0.59, cluster-internal 0.76–0.80 — so
 * the default 0.65 sits in the gap with margin (see the live battery
 * `verify-skill-merge.mjs`, which asserts no false-reject on a real merge).
 *
 * Fail-closed: if the embedder is unavailable the merge cannot be verified, so
 * it is rejected (deferred to a later idle tick) rather than committed blind —
 * SkillOpt's "accept only a verified edit". A small model is an unreliable
 * self-verifier (arXiv 2404.17140), so the gate is embeddings, not a model
 * self-judgement; the verdict shape leaves room for a rollout-based scorer.
 *
 * Cross-script pairs are skipped (treated as covered): nomic bridges
 * Hangul/CJK/kana↔Latin weakly, so comparing a Korean original to an English
 * merged text would false-reject legitimate bilingual consolidation. See
 * `comparableScript` — the gate only runs the cosine test within a shared
 * dominant script family.
 */

import { cosineSimilarity } from "./episodic-recall.js";
import { comparableScript } from "./script-family.js";
import type { SkillDraft } from "./skill-review.js";

export interface MergeCoverageVerdict {
  /** Accept the merge (commit it) only when this is true. */
  readonly accept: boolean;
  /** Fraction of the originals whose purpose the merged artifact still covers (0..1). */
  readonly score: number;
  /** Labels of the originals the merged artifact covers. */
  readonly covered: readonly string[];
  /** Labels of the originals the merged artifact dropped — the merge regression. */
  readonly lost: readonly string[];
  /** Human-readable summary for the action log / rejected-edit feedback. */
  readonly reason: string;
}

/** A merge input: `label` is reported in covered/lost, `text` is what gets embedded. */
export interface CoverageItem {
  readonly label: string;
  readonly text: string;
}

/** Back-compat alias — the skill-merge gate returns this same shape. */
export type UmbrellaCoverageVerdict = MergeCoverageVerdict;

export interface ValidateUmbrellaOptions {
  /** Embed text to a vector (the local nomic embedder). Required — the gate is semantic. */
  readonly embed: (text: string) => Promise<readonly number[]>;
  /**
   * Cosine floor for an original to count as covered by the umbrella. Default
   * 0.65 — calibrated for nomic-embed-text (good coverage ≥0.76, off-topic
   * ≤0.59). Raise it to demand tighter coverage, lower it to tolerate looser
   * generalisation.
   */
  readonly floor?: number;
  /**
   * When true (default), accept only if EVERY original is covered — a
   * consolidation may generalise wording but must not lose a skill's purpose.
   * When false, accept when `score` reaches `minScore`.
   */
  readonly requireAllCovered?: boolean;
  /** Floor on `score` when `requireAllCovered` is false. Default 1.0. */
  readonly minScore?: number;
}

const DEFAULT_FLOOR = 0.65;

/** The trigger surface that decides whether the agent reaches for a skill. */
function triggerText(skill: SkillDraft): string {
  return `${skill.name}. ${skill.description}`;
}

/**
 * Generic held-out coverage gate, shared by every self-improvement merge
 * (curator skill-merge, playbook strategy-merge, …): grade a `merged` artifact
 * against the `originals` it claims to replace by semantic coverage. Each
 * original is covered when cosine(original.text, merged.text) ≥ `floor`.
 * Fail-closed: any embedding error → reject (cannot verify). Empty input never
 * accepts.
 */
export async function validateMergeCoverage(
  originals: readonly CoverageItem[],
  merged: CoverageItem,
  options: ValidateUmbrellaOptions
): Promise<MergeCoverageVerdict> {
  if (originals.length === 0) {
    return { accept: false, covered: [], lost: [], reason: "empty cluster", score: 0 };
  }
  const floor = clamp01(options.floor ?? DEFAULT_FLOOR);
  const requireAll = options.requireAllCovered ?? true;
  const minScore = clamp01(options.minScore ?? 1);

  let mergedVec: readonly number[];
  const originalVecs: (readonly number[])[] = [];
  try {
    mergedVec = await options.embed(merged.text);
    for (const item of originals) {
      originalVecs.push(await options.embed(item.text));
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      accept: false,
      covered: [],
      lost: originals.map((o) => o.label),
      reason: `coverage gate could not run (embedder unavailable: ${message})`,
      score: 0
    };
  }

  const covered: string[] = [];
  const lost: string[] = [];
  originals.forEach((item, i) => {
    // Cross-script vs the merged text → out of the embedder's validity domain;
    // skip the cosine test (treat as covered) rather than false-reject.
    const comparable = comparableScript(item.text, merged.text);
    if (!comparable || cosineSimilarity(originalVecs[i]!, mergedVec) >= floor) {
      covered.push(item.label);
    } else {
      lost.push(item.label);
    }
  });

  const score = covered.length / originals.length;
  const accept = requireAll ? lost.length === 0 : score >= minScore;
  const reason = accept
    ? `"${merged.label}" covers all ${covered.length.toString()} (≥${floor.toFixed(2)})`
    : `"${merged.label}" drops [${lost.join(", ")}] (covered ${covered.length.toString()}/${originals.length.toString()}, floor ${floor.toFixed(2)})`;

  return { accept, covered, lost, reason, score };
}

/**
 * Curator skill-merge gate: grade an umbrella against the cluster it replaces.
 * Thin wrapper over {@link validateMergeCoverage} keyed on each skill's trigger
 * surface (name + "Use when …" description); covered/lost are reported by name.
 */
export function validateUmbrellaCoverage(
  cluster: readonly SkillDraft[],
  umbrella: SkillDraft,
  options: ValidateUmbrellaOptions
): Promise<MergeCoverageVerdict> {
  return validateMergeCoverage(
    cluster.map((s) => ({ label: s.name, text: triggerText(s) })),
    { label: umbrella.name, text: triggerText(umbrella) },
    options
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
