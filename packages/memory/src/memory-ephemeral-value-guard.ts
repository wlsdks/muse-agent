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
 */

const EPHEMERAL_VALUE_RE = /오늘|내일|모레|이따|방금|지금|아까/u;

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
