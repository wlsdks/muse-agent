import { detectUnscheduledRememberIntent as detectUnscheduledRememberIntentCore } from "@muse/agent-core";

/**
 * "Did the user ask Muse to remember something date-shaped this turn?" —
 * the trigger for the false-done honest-caveat backstop (channel reply
 * path, `inbound-agent-run.ts`).
 *
 * `packages/agent-core`'s `followup-detector.ts` landed a same-named export
 * (`detectUnscheduledRememberIntent`) mid-slice — this module UNIONS it with
 * a locally-built detector rather than fully deferring to it, because the
 * two are complementary, not redundant:
 *   - agent-core's version is KOREAN-ONLY and deliberately scoped to the
 *     "residual gap" `extractFollowupPromises` (its own promise parser)
 *     does NOT resolve (month-day, weekday names, 설날/추석 holidays, …) —
 *     it does not cover English, and does not cover formats
 *     `extractFollowupPromises` already parses (내일, "N분/시간 뒤", …).
 *   - This module's local detector is bilingual (EN required — the caveat
 *     itself has an EN variant) and covers the WIDER date vocabulary this
 *     backstop needs regardless of whether the promise parser would also
 *     resolve it (this backstop's ground-truth check is the followups
 *     STORE count, not a re-parse of the format — see
 *     `inbound-agent-run.ts`'s `countScheduledFollowups`).
 * A hit from EITHER is a legitimate remember-intent signal, so OR is the
 * safe combination — it only ever WIDENS recall (missing a real
 * remember-intent silently keeps a false-done lie uncaught; a spurious
 * extra caveat is merely mildly redundant, never wrong).
 */

const REMEMBER_VERB_KO_RE =
  /기억해(?:줘|둬|라|줄래|줄\s*수)?|기억하고\s*있어(?:줘)?|잊지\s*말고|잊지\s*마|리마인드(?:해줘)?|알림\s*(?:설정해|해)/u;
const REMEMBER_VERB_EN_RE = /\bremind\s+me\b|\breminder\b|\bremember\s+(?:this|that|to)\b|\bdon['’]?t\s+forget\b/iu;

const DATE_SHAPED_KO_RE =
  /\d{1,2}\s*월\s*\d{1,2}\s*일|내일|모레|글피|다음\s*주|이번\s*주|매일|매주|(?:월|화|수|목|금|토|일)요일|오전\s*\d{1,2}\s*시|오후\s*\d{1,2}\s*시|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?|\d{1,4}\s*(?:분|시간|일)\s*(?:뒤|후|이내)/u;

const DATE_SHAPED_EN_RE =
  /\btomorrow\b|\bnext\s+week\b|\bnext\s+(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\bin\s+\d{1,4}\s*(?:minutes?|hours?|days?)\b/iu;

function detectUnscheduledRememberIntentLocal(text: string): boolean {
  if (typeof text !== "string" || text.trim().length === 0) {
    return false;
  }
  if (!REMEMBER_VERB_KO_RE.test(text) && !REMEMBER_VERB_EN_RE.test(text)) {
    return false;
  }
  return DATE_SHAPED_KO_RE.test(text) || DATE_SHAPED_EN_RE.test(text);
}

export function detectUnscheduledRememberIntent(text: string): boolean {
  return detectUnscheduledRememberIntentLocal(text) || detectUnscheduledRememberIntentCore(text);
}
