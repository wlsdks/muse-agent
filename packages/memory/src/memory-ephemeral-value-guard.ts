/**
 * Ephemeral-value guard for durable fact promotion.
 *
 * User-sim audit finding (CONFIRMED): the auto-extractor persisted a
 * time-decaying phrase as a durable FACT — `climbing_gym_time` was stored
 * as `"오늘 저녁 7시"`. A relative-day time mention like that belongs to a
 * followup (it decays the moment "오늘" passes), not to permanent user
 * memory.
 *
 * Only RELATIVE-DAY expressions are excluded (오늘/내일/모레/이따/방금/지금/아까)
 * — an ABSOLUTE date ("8월 5일", "다음달 5일") is not ephemeral and is left
 * untouched, so this can never clip a genuine durable fact like a
 * birthday.
 *
 * The guard was Korean-only, and a live audit of the extractor caught what that
 * cost. A user who said he was in Lisbon LAST WEEK had `recent_location: "Lisbon"`
 * written as a durable fact — which recall will later cite as where he lives. That
 * is not merely noise; it is a fabrication with a citation, in the one product whose
 * release gate is fabrication = 0. The English relative-time family is now covered
 * on the same terms: relative only, never absolute.
 */

const EPHEMERAL_VALUE_RE =
  /오늘|내일|모레|이따|방금|지금|아까|저번\s*주|지난\s*주|요즘|최근|\b(today|tonight|tomorrow|yesterday|recently|lately|last\s+(week|night|month)|next\s+(week|month)|this\s+(morning|afternoon|evening|week)|the\s+other\s+day|just\s+now|right\s+now|currently|at\s+the\s+moment|these\s+days)\b/iu;

/** Whether a fact VALUE reads as a same-day-relative, time-decaying phrase. */
export function isEphemeralValue(value: string): boolean {
  return EPHEMERAL_VALUE_RE.test(value);
}

/** Drop any entry whose value is ephemeral (see {@link isEphemeralValue}). */
export function dropEphemeralFacts(
  record: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isEphemeralValue(value)) {
      out[key] = value;
    }
  }
  return out;
}
