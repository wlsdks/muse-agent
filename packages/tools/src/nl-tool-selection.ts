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
 * Resolve which of `toolNames` the model's prose selected. Deterministic:
 *   - an explicit no-tool phrase ⇒ none;
 *   - exactly one known tool name mentioned ⇒ that tool;
 *   - several mentioned ⇒ the FIRST occurrence in the text (the model's lead
 *     pick), so a "use A, not B" answer resolves to A;
 *   - none mentioned ⇒ none.
 * Tool names are matched as whole tokens (word-boundary), case-insensitively,
 * so `time_now` doesn't spuriously match inside another identifier.
 */
export function parseNaturalLanguageToolSelection(text: string, toolNames: readonly string[]): NlToolSelection {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { reason: "empty model output" };
  }
  const lower = text.toLowerCase();
  // Earliest-mentioned known tool wins (the model's lead choice).
  let best: { name: string; index: number } | undefined;
  for (const name of toolNames) {
    const re = new RegExp(`(?<![a-z0-9_])${escapeRegExp(name.toLowerCase())}(?![a-z0-9_])`, "i");
    const m = re.exec(lower);
    if (m && (best === undefined || m.index < best.index)) {
      best = { name, index: m.index };
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
  return { reason: "no known tool named" };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
