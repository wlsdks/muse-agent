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

export type CommitmentKind = "need-to" | "have-to" | "should" | "ko-haeya" | "ko-plan";

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
  { re: /([^.!?\n]{2,60}?)\s*해야\s*(?:해|돼|겠어|겠다|지)/gu, kind: "ko-haeya", confidence: "high" },
  { re: /([^.!?\n]{2,60}?)\s*하기로\s*했(?:어|다|지)/gu, kind: "ko-plan", confidence: "low" }
];

// Auxiliary that, placed right before "I", makes the clause an inverted
// question ("Do I need to…?", "Should I…?") rather than a commitment.
const INTERROGATIVE_PREFIX = /\b(?:do|does|did|should|would|will|can|could|may)\s*$/iu;

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
