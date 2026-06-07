export interface ToolArgumentGrounding {
  /** A NEW arguments object with ungrounded designated args removed. */
  readonly args: Record<string, unknown>;
  /** Names of the args that were dropped as fabricated (not in the utterance). */
  readonly dropped: readonly string[];
}

// Content tokens of a value/utterance: lowercased runs of letters/digits/Hangul,
// >= 2 chars (a 1-char token is too common to ground on). Used only to test
// whether an asserted value appears in the utterance, never re-emitted.
function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

/**
 * Deterministic anti-fabrication for tool ARGUMENTS. The local 8B fabricates
 * OPTIONAL free-text actuator annotations — a calendar `location` / `notes` the
 * user never mentioned ("회의 잡아줘" → location "강남역") — and they get
 * PERSISTED. A schema "omit if unspecified" instruction is ~0% effective on an
 * 8B, so the guarantee has to be CODE, not prompt (tool-calling.md). For each
 * arg a tool marks as `groundedArgs`, drop its value unless it is grounded in
 * the user's utterance.
 *
 * CONSERVATIVE on purpose (protect against false drops): a string value is kept
 * if ANY of its content tokens appears as a substring of the utterance — so a
 * value carried across Korean particle attachment ("강남역" grounded by
 * "강남역에서") survives, and only a value with NO overlap at all is dropped.
 * Non-string / empty values and an empty utterance are left untouched
 * (fail-open: never drop when grounding can't be assessed). Required args are
 * the caller's concern — pass only optional free-text arg names in `groundedArgs`.
 */
export function groundToolArguments(
  args: Record<string, unknown>,
  groundedArgs: readonly string[],
  utterance: string
): ToolArgumentGrounding {
  const haystack = utterance.toLowerCase();
  if (haystack.trim().length === 0 || groundedArgs.length === 0) {
    return { args, dropped: [] };
  }
  const dropped: string[] = [];
  const next: Record<string, unknown> = { ...args };
  for (const name of groundedArgs) {
    const value = next[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    const tokens = contentTokens(value);
    const grounded = tokens.length === 0 || tokens.some((token) => haystack.includes(token));
    if (!grounded) {
      delete next[name];
      dropped.push(name);
    }
  }
  return { args: next, dropped };
}
