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
 * Cosine floor for matching a discharge statement to the commitment it satisfies.
 * Moderate (0.55): "I emailed Bob the report" vs "email Bob the report" scores
 * high (~0.7+), while an unrelated discharge ("I called the dentist") scores low
 * (~0.2) — 0.55 sits in the gap, leaning toward UNDER-discharge (keep nagging)
 * over OVER-discharge (silently dropping a real open loop).
 */
export const COMMITMENT_DISCHARGE_COSINE = 0.55;

// Completion markers — a genuinely lexical/syntactic signal (a turn ANNOUNCING a
// finished action), allowed per the cumulative lesson. The SAME-commitment match
// is semantic (embedding cosine), never lexical. EN + KO.
const DISCHARGE_MARKER_EN = /\b(?:done|already|finished|completed|emailed|sent|called|submitted|booked|paid|handled|took\s+care\s+of|wrapped\s+up|sorted)\b/iu;
const DISCHARGE_MARKER_KO = /(?:끝냈|끝났|완료|했어|했다|했음|보냈|처리(?:했|함|완료)|마쳤|해결했)/u;

function hasDischargeMarker(text: string): boolean {
  return DISCHARGE_MARKER_EN.test(text) || DISCHARGE_MARKER_KO.test(text);
}

/**
 * In-conversation commitment-discharge filter (π-Bench, arXiv:2605.14678): a
 * proactive agent in a long-horizon workflow must not act on an intent the user
 * already SATISFIED later in the same trajectory — surfacing a discharged
 * commitment is a proactivity failure (nagging about a done thing). Detects the
 * user's commitments per turn, then DROPS any whose action a STRICTLY LATER user
 * turn discharges: that later turn carries a completion marker (lexical) AND its
 * embedding cosine to the commitment ≥ dischargeCosine (semantic same-action
 * match, per the cumulative lesson — not lexical overlap).
 *
 * SUBTRACTIVE: every returned element came from detectUserCommitments. FAIL-SOFT:
 * an embedder error returns the full detected set (today's behaviour — a missed
 * discharge nags once, never a false drop). Conservative: ordering is strict
 * (only a turn AFTER the commitment can discharge it), so a commitment voiced in
 * the same turn as a marker is never self-discharged.
 */
export async function selectOpenCommitments(
  userTurns: readonly string[],
  embed: (text: string) => Promise<readonly number[]>,
  options?: { readonly dischargeCosine?: number; readonly maxCommitments?: number }
): Promise<readonly UserCommitment[]> {
  const cosineFloor = options?.dischargeCosine ?? COMMITMENT_DISCHARGE_COSINE;
  const maxCommitments = Math.max(1, Math.trunc(options?.maxCommitments ?? 10));
  // Per-turn detection so each commitment carries its source turn index.
  const detected: { readonly commitment: UserCommitment; readonly turnIndex: number }[] = [];
  for (let i = 0; i < userTurns.length; i += 1) {
    const turn = userTurns[i];
    if (typeof turn !== "string" || turn.trim().length === 0) continue;
    for (const commitment of detectUserCommitments([turn], { maxCommitments: 100 })) {
      detected.push({ commitment, turnIndex: i });
    }
  }
  if (detected.length === 0) return [];
  const dischargeTurns: { readonly index: number; readonly text: string }[] = [];
  for (let i = 0; i < userTurns.length; i += 1) {
    const turn = userTurns[i];
    if (typeof turn === "string" && hasDischargeMarker(turn)) dischargeTurns.push({ index: i, text: turn });
  }
  let commitmentVecs: ReadonlyArray<readonly number[]>;
  let dischargeVecs: ReadonlyArray<readonly number[]>;
  try {
    commitmentVecs = await Promise.all(detected.map((d) => embed(d.commitment.text)));
    dischargeVecs = await Promise.all(dischargeTurns.map((d) => embed(d.text)));
  } catch {
    // Fail-soft: degrade to today's behaviour (the whole-array detected set).
    return detectUserCommitments(userTurns, options);
  }
  const open: UserCommitment[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < detected.length; i += 1) {
    const { commitment, turnIndex } = detected[i]!;
    const cvec = commitmentVecs[i]!;
    const discharged = dischargeTurns.some(
      (d, j) => d.index > turnIndex && cosineSimilarity(cvec, dischargeVecs[j]!) >= cosineFloor
    );
    if (discharged) continue;
    const key = `${commitment.kind}:${commitment.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    open.push(commitment);
    if (open.length >= maxCommitments) break;
  }
  return open;
}

/**
 * Cross-session auto-discharge (π-Bench arXiv:2605.14678): given PERSISTED scheduled
 * commitments and this session's user turns, return the ids of those the user now
 * reports done — so a standing check-in isn't fired for a thing already handled. The
 * in-session `selectOpenCommitments` filter only drops a commitment discharged LATER in
 * the SAME conversation; a persisted check-in outlives the session, and the "I did it"
 * usually arrives in a FUTURE session it can't see. Same signal (a discharge-MARKER turn
 * AND cosine ≥ floor) and the SAME `COMMITMENT_DISCHARGE_COSINE` — no new threshold.
 * Conservative (marker AND cosine): a missed discharge nags once, a false-cancel silently
 * drops a real loop. Fail-soft: an embedder error discharges nothing (keep the check-ins).
 * `embed` injected (deterministic in tests). Pure over its inputs.
 */
export async function selectDischargedCommitments(
  scheduled: readonly { readonly id: string; readonly commitment: string }[],
  userTurns: readonly string[],
  embed: (text: string) => Promise<readonly number[]>,
  options?: { readonly dischargeCosine?: number }
): Promise<readonly string[]> {
  const cosineFloor = options?.dischargeCosine ?? COMMITMENT_DISCHARGE_COSINE;
  const dischargeTurns = userTurns.filter((t) => typeof t === "string" && hasDischargeMarker(t));
  const candidates = scheduled.filter((c) => c.commitment.trim().length > 0);
  if (dischargeTurns.length === 0 || candidates.length === 0) return [];
  let turnVecs: ReadonlyArray<readonly number[]>;
  let commitmentVecs: ReadonlyArray<readonly number[]>;
  try {
    turnVecs = await Promise.all(dischargeTurns.map((t) => embed(t)));
    commitmentVecs = await Promise.all(candidates.map((c) => embed(c.commitment)));
  } catch {
    return []; // fail-soft: discharge nothing, keep every scheduled check-in
  }
  const out: string[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const cvec = commitmentVecs[i]!;
    if (turnVecs.some((tv) => cosineSimilarity(cvec, tv) >= cosineFloor)) {
      out.push(candidates[i]!.id);
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
