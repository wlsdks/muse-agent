/**
 * Natural-language tool selection parser (Natural Language Tools, arXiv
 * 2510.14453: "A Natural Language Approach to Tool Calling In Large Language
 * Agents"). The paper shows forcing a small/open-weight model to emit strict
 * tool-call JSON degrades selection accuracy; letting it state the tool choice
 * in PROSE and parsing that deterministically recovers accuracy and cuts
 * variance. This module is the deterministic parse half — map a model's prose
 * answer ("I'd use `time_now` to get the current time") to one known tool name
 * (or none), so the SELECTION step never depends on the model emitting valid
 * JSON.
 */

export interface NlToolSelection {
  /** The chosen tool name, or undefined when the model declined / picked none. */
  readonly tool?: string;
  /** Why this verdict — for eval transparency, not the model's own reason. */
  readonly reason: string;
}

const NO_TOOL_RE = /\b(no[\s-]?tool|none|no tool is needed|not? (?:a )?tool|n\/a|없음|필요\s*없)/i;

/**
 * A negation cue sitting immediately before a tool mention — the model is
 * REJECTING that tool ("don't use X", "not X", "X은 쓰지 마"/"X 말고"), so the
 * mention must not count as a selection. Matched on the gap between the end of
 * the cue and the start of the tool name: an EN cue ends right before the name
 * (with optional "use"/article filler), a KO post-positional cue follows the
 * name. Kept tight so a benign "without X" / a trailing "not B" after a real
 * pick does not over-skip.
 */
const EN_NEGATION_LEAD_RE = /\b(?:do\s+not|don['’]t|cannot|can['’]t|won['’]t|never|not)\s+(?:use\s+|call\s+|the\s+|a\s+)?$/i;
const KO_NEGATION_TRAIL_RE = /^\s*(?:은|는|을|를|이|가)?\s*(?:쓰지\s*마|쓰지\s*말|사용하지\s*마|사용하지\s*말|말고|대신|빼고)/u;

/**
 * Resolve which of `toolNames` the model's prose selected. Deterministic:
 *   - an explicit no-tool phrase ⇒ none;
 *   - exactly one known tool name mentioned ⇒ that tool;
 *   - several mentioned ⇒ the FIRST NON-NEGATED occurrence (the model's lead
 *     pick), so "use A, not B" → A AND "don't use B, use A" → A — a mention the
 *     model explicitly rejects is skipped (reasoning-action alignment, MAST
 *     arXiv 2503.13657: selecting a tool the plan rejected is a mismatch);
 *   - every mention negated, or none ⇒ none.
 * Tool names are matched as whole tokens (word-boundary), case-insensitively,
 * so `time_now` doesn't spuriously match inside another identifier.
 */
export function parseNaturalLanguageToolSelection(text: string, toolNames: readonly string[]): NlToolSelection {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { reason: "empty model output" };
  }
  const lower = text.toLowerCase();
  // Earliest NON-NEGATED known tool wins (the model's lead choice).
  let best: { name: string; index: number } | undefined;
  let sawNegatedMention = false;
  for (const name of toolNames) {
    const re = new RegExp(`(?<![a-z0-9_])${escapeRegExp(name.toLowerCase())}(?![a-z0-9_])`, "giu");
    for (let m = re.exec(lower); m !== null; m = re.exec(lower)) {
      if (isNegatedMention(text, m.index, name.length)) {
        sawNegatedMention = true;
        continue;
      }
      if (best === undefined || m.index < best.index) {
        best = { name, index: m.index };
      }
      break; // first non-negated occurrence of this name is enough
    }
  }
  if (best) {
    // A tool was named — that's an affirmative selection even if the prose also
    // contains the word "none" elsewhere ("use time_now, none of the others").
    return { tool: best.name, reason: `named tool "${best.name}" at index ${best.index.toString()}` };
  }
  if (NO_TOOL_RE.test(lower)) {
    return { reason: "explicit no-tool answer" };
  }
  if (sawNegatedMention) {
    return { reason: "only negated tool mentions" };
  }
  return { reason: "no known tool named" };
}

function isNegatedMention(text: string, index: number, nameLength: number): boolean {
  const before = text.slice(Math.max(0, index - 24), index);
  if (EN_NEGATION_LEAD_RE.test(before)) return true;
  const after = text.slice(index + nameLength, index + nameLength + 16);
  return KO_NEGATION_TRAIL_RE.test(after);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
