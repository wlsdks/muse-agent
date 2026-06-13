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
 * Cross-script pairs are UNVERIFIABLE, not covered: nomic bridges
 * Hangul/CJK/kana↔Latin weakly, so a Korean-original vs English-merged cosine is
 * meaningless. Such a pair is reported in `unverified` and BLOCKS acceptance
 * (fail-closed / defer) — auto-covering it would let the gate do zero work for a
 * non-Latin cluster. The mergers are told to write their output in the input's
 * language, so a legitimate edit is same-script and verifiable; only a
 * language-disobeying proposal defers (safely retried next time).
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
  /**
   * Labels the gate could NOT verify because the original and the merged text
   * are in different scripts (out of the embedder's validity domain). These are
   * NOT covered — a merge with any unverified original is fail-closed (deferred),
   * never committed blind. Steered-retry feedback uses `lost`, not these.
   */
  readonly unverified: readonly string[];
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
    return { accept: false, covered: [], lost: [], reason: "empty cluster", score: 0, unverified: [] };
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
      score: 0,
      unverified: []
    };
  }

  const covered: string[] = [];
  const lost: string[] = [];
  const unverified: string[] = [];
  originals.forEach((item, i) => {
    // Cross-script vs the merged text → out of the embedder's validity domain.
    // It is UNVERIFIABLE, not covered: auto-covering it would let the gate do
    // zero work for a non-Latin cluster (accept an unrelated umbrella / a
    // fabricated trait). Fail-closed — an unverified pair blocks acceptance.
    if (!comparableScript(item.text, merged.text)) {
      unverified.push(item.label);
    } else if (cosineSimilarity(originalVecs[i]!, mergedVec) >= floor) {
      covered.push(item.label);
    } else {
      lost.push(item.label);
    }
  });

  const score = covered.length / originals.length;
  const verifiedAccept = requireAll ? lost.length === 0 : score >= minScore;
  const accept = verifiedAccept && unverified.length === 0;
  const reason = accept
    ? `"${merged.label}" covers all ${covered.length.toString()} (≥${floor.toFixed(2)})`
    : unverified.length > 0
      ? `"${merged.label}" unverifiable — cross-script vs [${unverified.join(", ")}]; deferred (write it in the same language to verify)`
      : `"${merged.label}" drops [${lost.join(", ")}] (covered ${covered.length.toString()}/${originals.length.toString()}, floor ${floor.toFixed(2)})`;

  return { accept, covered, lost, reason, score, unverified };
}

/**
 * Curator skill-merge gate: grade an umbrella against the cluster it replaces on
 * TWO surfaces, requiring both — because a skill is a trigger AND a procedure:
 *  - TRIGGER (name + "Use when …" description): is the umbrella still SELECTED for
 *    each original's purpose? Catches an off-topic / wrong-purpose umbrella.
 *  - BODY (the steps): does the umbrella's procedure still COVER each original's?
 *    Catches a "gutted body" umbrella whose trigger covers the cluster but whose
 *    body is hollow/"TODO" — the trigger surface alone can't see this (trigger
 *    cosine is identical whether the body is real or gutted), so a body-only
 *    check is required. Calibrated on nomic-embed-text: a real generalising body
 *    scores 0.84–0.87 against its originals' bodies, a gutted/vague/off-topic body
 *    0.33–0.54 — so the default 0.65 floor sits in a wide gap on BOTH surfaces.
 *
 * An original is covered iff covered on BOTH surfaces; lost/unverified are the
 * union (a skill dropped on either surface fails). The generic
 * {@link validateMergeCoverage} stays body-agnostic so the playbook path (no
 * body) keeps using it directly.
 *
 * NOT added — a SkillOpt "textual learning rate" / anchor bound (reject an
 * umbrella that drifts too far from the cluster centroid). Calibration on
 * nomic-embed-text showed no usable threshold: a buried scope-creep umbrella
 * ("summarise … AND book flights AND manage calendar") scores 0.866 to the
 * cluster centroid — ABOVE a terse-but-legitimate generalisation ("summarise
 * any content", 0.809) — because the on-topic majority dominates the embedding.
 * Any floor that rejects the creep also false-rejects real generalisation, so an
 * embedding anchor can't bound bloat without re-introducing the very false-reject
 * this gate was fixed to avoid. (Catching buried scope-creep would need claim
 * decomposition / an LLM judge, which this gate deliberately avoids.)
 */
export async function validateUmbrellaCoverage(
  cluster: readonly SkillDraft[],
  umbrella: SkillDraft,
  options: ValidateUmbrellaOptions
): Promise<MergeCoverageVerdict> {
  const trigger = await validateMergeCoverage(
    cluster.map((s) => ({ label: s.name, text: triggerText(s) })),
    { label: umbrella.name, text: triggerText(umbrella) },
    options
  );
  const body = await validateMergeCoverage(
    cluster.map((s) => ({ label: s.name, text: s.body })),
    { label: umbrella.name, text: umbrella.body },
    options
  );
  const lost = [...new Set([...trigger.lost, ...body.lost])];
  const unverified = [...new Set([...trigger.unverified, ...body.unverified])];
  const covered = cluster.map((s) => s.name).filter((n) => !lost.includes(n) && !unverified.includes(n));
  const score = cluster.length === 0 ? 0 : covered.length / cluster.length;
  // Re-gate the COMBINED (covered-on-BOTH-surfaces) score: each surface applies
  // its floor to its OWN partial coverage, so a skill lost on trigger and a
  // different one lost on body each clear their surface (2/3 ≥ floor) yet the
  // union drops a majority. requireAll → no combined loss; else combined ≥ minScore.
  const requireAll = options.requireAllCovered ?? true;
  const minScore = clamp01(options.minScore ?? 1);
  const combinedAccept = requireAll ? lost.length === 0 : score >= minScore;
  const accept = trigger.accept && body.accept && combinedAccept;
  const embedderError = [trigger.reason, body.reason].find((r) => r.includes("embedder unavailable"));
  const reason = accept
    ? `umbrella "${umbrella.name}" covers all ${covered.length.toString()} on trigger+body`
    : embedderError
      ? embedderError
      : unverified.length > 0
        ? `umbrella "${umbrella.name}" unverifiable — cross-script vs [${unverified.join(", ")}]; deferred`
        : `umbrella "${umbrella.name}" drops [${lost.join(", ")}] (trigger or body coverage below floor)`;
  return { accept, covered, lost, reason, score, unverified };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
