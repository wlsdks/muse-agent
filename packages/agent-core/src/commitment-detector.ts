/**
 * User open-loop / commitment detector — rule-only first pass.
 *
 * The follow-up detector ([[followup-detector]]) captures the
 * *assistant's* time-bound promises. This captures the mirror image:
 * commitments the *user* voices in passing ("I need to email Bob",
 * "내일 자료 준비해야 해") that never became a formal task or reminder.
 * Surfacing them lets Muse remind the user of their own open loops.
 *
 * Conservative by design — it leans toward false negatives over
 * spurious captures (a missed open loop beats nagging about a
 * non-commitment). Only explicit first-person commitment phrases are
 * matched; questions, opinions, and vague intents are ignored. Pure:
 * no I/O, no model call.
 *
 * Concept adapted from OpenClaw's flagged open-loop / commitment
 * extraction for proactive follow-up (MIT) — deterministic
 * reimplementation for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */

import { cosineSimilarity } from "./episodic-recall.js";

export type CommitmentKind = "need-to" | "have-to" | "should" | "will" | "ko-haeya" | "ko-plan";

export interface UserCommitment {
  /** The captured commitment clause (the action), trimmed. */
  readonly text: string;
  /**
   * "high" — an explicit obligation ("I need/have/got to", "~해야 해").
   * "low"  — a softer intent ("I should", "~하기로 했어").
   */
  readonly confidence: "high" | "low";
  readonly kind: CommitmentKind;
}

export interface DetectUserCommitmentsOptions {
  /** Hard cap on returned commitments. Default 10. */
  readonly maxCommitments?: number;
}

interface Rule {
  readonly re: RegExp;
  readonly kind: CommitmentKind;
  readonly confidence: "high" | "low";
}

// Each pattern is global + anchored on a first-person obligation and stops
// at the first clause terminator (captured as group 2 for the EN rules, so a
// trailing "?" can be recognised as a question). KO rules end on the verb
// stem and carry no terminator group.
const RULES: readonly Rule[] = [
  { re: /\bI\s+need\s+to\s+([^.!?\n]{2,120}?)\s*([.!?\n]|$)/giu, kind: "need-to", confidence: "high" },
  { re: /\bI(?:'ve|\s+have)?\s+got\s+to\s+([^.!?\n]{2,120}?)\s*([.!?\n]|$)/giu, kind: "have-to", confidence: "high" },
  { re: /\bI\s+have\s+to\s+([^.!?\n]{2,120}?)\s*([.!?\n]|$)/giu, kind: "have-to", confidence: "high" },
  { re: /\bI\s+should\s+([^.!?\n]{2,120}?)\s*([.!?\n]|$)/giu, kind: "should", confidence: "low" },
  // The most common way a person voices a commitment in passing: a stated
  // intent ("I'll email Bob", "I will finish the report", "I'm going to / gonna
  // call the dentist"). A small stative-starter stoplist below drops the
  // non-actionable forms ("I'll be late", "I'll see").
  { re: /\bI(?:'ll|\s+will)\s+([^.!?\n]{2,120}?)\s*([.!?\n]|$)/giu, kind: "will", confidence: "high" },
  { re: /\bI(?:'m|\s+am)\s+(?:going\s+to|gonna)\s+([^.!?\n]{2,120}?)\s*([.!?\n]|$)/giu, kind: "will", confidence: "high" },
  { re: /([^.!?\n]{2,60}?)\s*해야\s*(?:해|돼|겠어|겠다|지)/gu, kind: "ko-haeya", confidence: "high" },
  { re: /([^.!?\n]{2,60}?)\s*하기로\s*했(?:어|다|지)/gu, kind: "ko-plan", confidence: "low" }
];

// Auxiliary that, placed right before "I", makes the clause an inverted
// question ("Do I need to…?", "Should I…?") rather than a commitment.
const INTERROGATIVE_PREFIX = /\b(?:do|does|did|should|would|will|can|could|may)\s*$/iu;

// First word of an "I'll/I'm going to <X>" clause that makes it a stative remark,
// not an actionable commitment ("I'll be late", "I'll see", "I'll bet/say").
const WILL_STATIVE_STARTERS = new Set(["be", "see", "bet", "say"]);

export function detectUserCommitments(
  userTurns: readonly string[],
  options: DetectUserCommitmentsOptions = {}
): readonly UserCommitment[] {
  const max = Math.max(1, Math.trunc(options.maxCommitments ?? 10));
  const out: UserCommitment[] = [];
  const seen = new Set<string>();
  for (const turn of userTurns) {
    if (typeof turn !== "string" || turn.trim().length === 0) continue;
    for (const rule of RULES) {
      for (const match of turn.matchAll(rule.re)) {
        const text = (match[1] ?? "").trim().replace(/\s+/gu, " ");
        if (text.length < 2) continue;
        // A clause that ENDS in "?" or is an inverted question ("Do I need
        // to…?") is a question, not a commitment — skip it.
        if (match[2] === "?") continue;
        const before = turn.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
        if (INTERROGATIVE_PREFIX.test(before)) continue;
        // A stated-intent clause whose verb is stative ("I'll be late", "I'll
        // see") is a remark, not a task — don't surface it as a commitment.
        if (rule.kind === "will" && WILL_STATIVE_STARTERS.has((text.split(/\s+/u)[0] ?? "").toLowerCase())) continue;
        // A NEGATED clause ("I will not email Bob", "I'll never call", "I should
        // not ship it") captures "not email Bob" / "never call" as the action —
        // a non-commitment. Surfacing it would nag the user about a thing they
        // said they would NOT do; drop it (conservative bias: a missed loop
        // beats a spurious capture).
        if (/^(?:not|never)\s/iu.test(text)) continue;
        const key = `${rule.kind}:${text.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, confidence: rule.confidence, kind: rule.kind });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * Conservative SemDeDup threshold (arXiv:2303.09540, Abbas et al. 2023).
 * 0.86 is high enough that only truly near-duplicate phrasings collapse
 * (e.g. "email Bob the report" / "email Bob about the report") while
 * topically related but distinct commitments (different recipient, task,
 * or domain) are kept separate — the cluster is semantic identity, not
 * topical proximity.
 */
export const COMMITMENT_DEDUP_COSINE = 0.86;

/**
 * Semantic near-duplicate collapse using a greedy single-pass algorithm
 * (SemDeDup, arXiv:2303.09540, Abbas/Tirumala/Simig/Ganguli/Morcos 2023).
 *
 * Each commitment is embedded; items are visited in input order. An item
 * joins the first existing cluster whose kept representative scores
 * cosineSimilarity ≥ threshold against it; otherwise it starts a new
 * cluster. The representative kept per cluster is the higher-confidence
 * member ("high" beats "low"); on a tie the earlier / shorter form is
 * kept (canonical: the first phrasing the user voiced).
 *
 * SUBTRACTIVE: every returned element is === an element from the input.
 * FAIL-SOFT: any embedder error → input returned unchanged.
 * NON-OVER-COLLAPSE: zero-norm → cosineSimilarity 0 → never falsely merges.
 */
export async function collapseNearDuplicateCommitments(
  commitments: readonly UserCommitment[],
  embed: (text: string) => Promise<readonly number[]>,
  options?: { readonly threshold?: number }
): Promise<readonly UserCommitment[]> {
  if (commitments.length <= 1) return commitments;
  const threshold = options?.threshold ?? COMMITMENT_DEDUP_COSINE;

  let vectors: ReadonlyArray<readonly number[]>;
  try {
    vectors = await Promise.all(commitments.map((c) => embed(c.text)));
  } catch {
    return commitments;
  }

  // Each cluster entry: the index (in commitments) of the kept representative.
  const clusterReps: number[] = [];

  for (let i = 0; i < commitments.length; i += 1) {
    const vec = vectors[i]!;
    let joined = false;
    for (const repIdx of clusterReps) {
      const sim = cosineSimilarity(vec, vectors[repIdx]!);
      if (sim >= threshold) {
        // This item is a near-duplicate of the cluster rep. Pick the better
        // representative: "high" confidence beats "low"; on a tie keep the
        // shorter (canonical) form, which is always the earlier one since we
        // walk in input order and the earlier item is already the rep.
        const current = commitments[repIdx]!;
        const incoming = commitments[i]!;
        if (incoming.confidence === "high" && current.confidence !== "high") {
          // Replace rep with the higher-confidence incoming item.
          clusterReps[clusterReps.indexOf(repIdx)] = i;
        }
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusterReps.push(i);
    }
  }

  // Preserve input order of kept representatives.
  clusterReps.sort((a, b) => a - b);
  return clusterReps.map((idx) => commitments[idx]!);
}
