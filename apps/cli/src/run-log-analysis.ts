/**
 * Signal-based work discovery: turn the run-log traces Muse already writes to
 * `.muse/runs/*.jsonl` into ranked candidate work, so gap-scout picks REAL
 * recurring failures (an answer that kept coming back "I'm not sure", a run that
 * kept failing) over a guess from reading the code. The dominant 2026 pattern is
 * signal-driven triage; this is its deterministic core. Pure (no fs) so it is
 * behaviorally testable with fixtures — the caller globs the `.jsonl` files.
 */

import { isRecord } from "@muse/shared";

export interface RunLogEvent {
  readonly message?: string;
  /** The model's answer text (from `response.response`), if captured. */
  readonly answer?: string;
  /** Grounding verdict at the top level (string | {verdict} | boolean | null). */
  readonly grounded?: unknown;
  /** Run outcome (`false` = the run failed). */
  readonly success?: boolean | null;
  /** What retrieval surfaced (from `response.retrieval`): the top sources + scores.
   *  Lets the analyzer tell an actionable grounding MISS (confident personal
   *  evidence existed but the answer wasn't grounded in it) from a non-actionable
   *  one (a general-knowledge / missing-note question with no confident source). */
  readonly retrieval?: readonly { readonly source: string; readonly score: number }[];
}

// Synthetic grounding-evidence sources (not real personal NOTES): exact-match
// entries the ask path injects for tasks/events/memory/etc. carry a constant 1.0
// and are not "the user has a relevant note" — so they don't count as confident
// personal evidence for the actionable-failure test.
const SYNTHETIC_SOURCE = /^(task|event|memory|session|tool|contact|action|command|commit|reminder|calendar|feed):/u;

// The confident-recall cosine floor (v2-moe default). A retrieved real note at or
// above this is genuine evidence the answer SHOULD have grounded in.
const CONFIDENT_PERSONAL_BAR = 0.45;

/** True when retrieval surfaced a confident REAL personal note (file source ≥ the
 *  bar). Older traces (no retrieval field) → true, preserving prior behavior. */
function hadConfidentPersonalSource(event: RunLogEvent): boolean {
  if (!Array.isArray(event.retrieval)) return true;
  return event.retrieval.some(
    (r) => typeof r.score === "number" && r.score >= CONFIDENT_PERSONAL_BAR && !SYNTHETIC_SOURCE.test(r.source)
  );
}

type FailureKind = "ungrounded" | "failed" | "misgrounded" | "contested";

export interface FailureCluster {
  /** Normalized representative of the failing message — the candidate work's subject. */
  readonly topic: string;
  /** How many traces failed this way (frequency = priority). */
  readonly count: number;
  readonly kind: FailureKind;
  /** A few verbatim example messages for the backlog entry. */
  readonly examples: readonly string[];
}

const NOT_GROUNDED = new Set(["ungrounded", "weak", "misgrounded", "contested"]);

/** The grounding verdict carried by an event, lowercased, or undefined if unlabeled. */
function groundingVerdict(grounded: unknown): string | undefined {
  if (typeof grounded === "string") return grounded.toLowerCase();
  if (typeof grounded === "boolean") return grounded ? "grounded" : "ungrounded";
  if (isRecord(grounded) && "verdict" in grounded) {
    const verdict = grounded.verdict;
    return typeof verdict === "string" ? verdict.toLowerCase() : undefined;
  }
  return undefined;
}

/**
 * Did this trace fail in a way worth turning into work? A failed run
 * (`success === false`), a grounding miss (`ungrounded`/`weak`), or a
 * `misgrounded` answer (the gate matched a real source that doesn't support the
 * claim — GROUNDED != TRUE, the failure class that otherwise hides as a success). An unlabeled
 * trace (null/undefined) carries no signal and is NOT a failure — never invent
 * work from the absence of a label.
 */
export function isFailureEvent(event: RunLogEvent): boolean {
  if (event.success === false) return true;
  const verdict = groundingVerdict(event.grounded);
  if (verdict === undefined || !NOT_GROUNDED.has(verdict)) return false;
  // An ungrounded/weak answer is only an ACTIONABLE failure when there was confident
  // personal evidence to ground in. A general-knowledge question ("what is 2+2?") or
  // a missing-note question has no confident source — its ungrounded answer is correct
  // (or a user data gap), NOT a Muse bug, so it must not pollute the flywheel as a
  // false failure. `misgrounded`/`contested` ALWAYS count (a source WAS matched).
  if ((verdict === "ungrounded" || verdict === "weak") && !hadConfidentPersonalSource(event)) {
    return false;
  }
  // An ungrounded EMPTY answer is a non-answer (the model produced nothing —
  // typically a no-tool dev/test run), not an actionable grounding miss. Only an
  // ungrounded NON-EMPTY answer is a real missed attempt worth turning into work.
  // An absent answer field (older traces) defaults to counting — backward compat.
  return typeof event.answer === "string" ? event.answer.trim().length > 0 : true;
}

function failureKind(event: RunLogEvent): FailureKind {
  if (event.success === false) return "failed";
  const verdict = groundingVerdict(event.grounded);
  if (verdict === "misgrounded") return "misgrounded";
  if (verdict === "contested") return "contested";
  return "ungrounded";
}

/** Collapse a message to a clustering key so the SAME question (modulo case /
 *  spacing / trailing punctuation) groups together. Paraphrase-merging is a
 *  future enhancement; exact-normalized already catches "it failed N times". */
function normalizeTopic(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/gu, " ").replace(/[?？!.…]+$/u, "");
}

/**
 * Cluster the FAILING traces by (kind, normalized topic), count each, and rank
 * by frequency (most-recurring failure first) — the candidate work list. A clean
 * board (all grounded successes) returns `[]`: no signal-driven work to do.
 */
export function analyzeRunLogSignals(events: readonly RunLogEvent[]): FailureCluster[] {
  const groups = new Map<string, { topic: string; kind: FailureKind; examples: string[]; count: number }>();
  for (const event of events) {
    if (typeof event.message !== "string" || event.message.trim().length === 0) continue;
    if (!isFailureEvent(event)) continue;
    const kind = failureKind(event);
    const topic = normalizeTopic(event.message);
    const key = `${kind}\u0000${topic}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < 3) existing.examples.push(event.message);
    } else {
      groups.set(key, { count: 1, examples: [event.message], kind, topic });
    }
  }
  return [...groups.values()]
    .map((group) => ({ count: group.count, examples: group.examples, kind: group.kind, topic: group.topic }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}
