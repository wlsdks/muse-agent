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
 * Empty values and an empty utterance are left untouched (fail-open: never drop
 * when grounding can't be assessed). A string-ARRAY arg (e.g. task `tags`) keeps
 * its grounded elements and drops only the fabricated ones; a partially-cleaned
 * array keeps the surviving elements and is NOT listed in `dropped` — `dropped`
 * contains only args whose value was removed entirely. Required args are the
 * caller's concern — pass only optional free-text arg names in `groundedArgs`.
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
  // Match a value token at a WORD START (preceded by start-of-string or a
  // non-letter/digit), not as a raw substring: a fabricated "art" is NOT grounded
  // by "start the meeting", while morphology ("meeting" prefixes "meetings") and
  // Korean particle attachment ("강남역" prefixes "강남역에서") still ground — both
  // are prefix matches. contentTokens yields [\p{L}\p{N}] runs only, so the token
  // carries no regex metacharacters and needs no escaping.
  const tokenGrounded = (token: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${token}`, "u").test(haystack);
  const isGrounded = (value: string): boolean => {
    const tokens = contentTokens(value);
    return tokens.length === 0 || tokens.some(tokenGrounded);
  };
  const dropped: string[] = [];
  const next: Record<string, unknown> = { ...args };
  for (const name of groundedArgs) {
    const value = next[name];
    if (typeof value === "string" && value.trim().length > 0) {
      if (!isGrounded(value)) {
        delete next[name];
        dropped.push(name);
      }
      continue;
    }
    // A string ARRAY (e.g. task `tags`) — drop the fabricated ELEMENTS, keep the
    // grounded ones; remove the arg entirely only if nothing survives.
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const kept = (value as string[]).filter((item) => item.trim().length === 0 || isGrounded(item));
      if (kept.length === 0 && value.length > 0) {
        // every element fabricated → the arg itself is dropped
        delete next[name];
        dropped.push(name);
      } else if (kept.length < value.length) {
        // partial: keep the grounded elements; the arg SURVIVES, so it is NOT
        // reported as "dropped" (dropped = args removed entirely, per the contract)
        next[name] = kept;
      }
    }
  }
  return { args: next, dropped };
}
