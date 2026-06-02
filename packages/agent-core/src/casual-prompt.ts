/**
 * Deterministic casual / social-prompt detector for the recall surface. A bare
 * "hi" / "thanks" / "bye" is NOT a question about the user's notes, yet it
 * currently runs the whole grounding pipeline — retrieval, the empty-corpus
 * on-ramp, a fabricated `[action: …]` citation the gate then strips, and a
 * "treat as unverified" grounding warning on the word "Hello!". tool-calling.md
 * is explicit: do not invoke the retrieval machinery on a greeting. This
 * classifies a PURE social prompt so the caller can answer it conversationally
 * and skip all of that.
 *
 * PRECISION-FIRST: only a short query whose WHOLE content is a social phrase
 * matches (anchored), so "hi, what's my rent?" or "thanks — when is the dentist?"
 * fall through to the normal grounded path. A miss costs nothing (normal path);
 * a false positive would skip grounding on a real question, so the bar is high.
 */

export type CasualPromptKind = "greeting" | "thanks" | "farewell";

const CASUAL_PATTERNS: ReadonlyArray<{ readonly kind: CasualPromptKind; readonly re: RegExp }> = [
  { kind: "greeting", re: /^(hi+|hey+|hello+|helo|yo|hiya|howdy|sup|gm|good morning|good evening|good afternoon|안녕|안녕하세요|하이|헬로|여보세요)( there| muse)?$/u },
  { kind: "thanks", re: /^(thanks?|thank you|thanks a lot|thank u|thx|ty|tysm|cheers|much appreciated|appreciate it|고마워|고마워요|고맙습니다|감사|감사해|감사해요|감사합니다|땡큐)$/u },
  { kind: "farewell", re: /^(bye+|bye bye|goodbye|good bye|see you|see ya|see you later|cya|later|good ?night|take care|잘있어|잘 있어|안녕히|안녕히 계세요|잘가|잘 가|바이|다음에 봐)$/u }
];

function normalizeSocialPrompt(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[!?.…~,\s]+$/u, "")
    .replace(/\s+/gu, " ");
}

/**
 * The social kind of a prompt, or `null` for anything that carries an actual
 * request. Normalises case, collapses whitespace, and strips trailing social
 * punctuation ("hi!!!" → "hi") before matching the anchored patterns. A query
 * longer than 30 chars is never casual (it carries content).
 */
export function classifyCasualPrompt(query: string): CasualPromptKind | null {
  const normalized = normalizeSocialPrompt(query);
  if (normalized.length === 0 || normalized.length > 30) {
    return null;
  }
  for (const { kind, re } of CASUAL_PATTERNS) {
    if (re.test(normalized)) {
      return kind;
    }
  }
  return null;
}

// A self-referential question ABOUT Muse ("what can you do", "넌 뭐야") — not a
// question about the user's notes. The local model otherwise free-composes an
// aspirational, often OVER-CLAIMED answer ("I can manage your schedule…") and
// gets a grounding warning. Anchored so "what can you do about my taxes" or
// "how do you cook rice" never match — only a whole-query meta phrase does.
const META_PROMPT_RE =
  /^(what can you (do|help( me)? with)|what do you do|what are you|who are you|what'?s? (is )?muse|how (do|does) (you|this|it) work|what can (i|you) ask|help|뭐\s?할\s?수\s?있어|무엇을?\s?할\s?수\s?있어|넌?\s?뭐야|너\s?뭐야|어떻게\s?(작동|동작)해|도움말|사용법)$/u;

/** True when the prompt asks about MUSE ITSELF (capabilities / identity / usage). */
export function classifyMetaPrompt(query: string): boolean {
  const normalized = normalizeSocialPrompt(query);
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }
  return META_PROMPT_RE.test(normalized);
}
