/**
 * Date primitives shared by the English and Korean relative-time resolvers:
 * calendar-month arithmetic (overflow-clamped) and local start-of-day. Split
 * out of loopback-relative-time.ts so the Korean resolver can import them
 * without a cycle back into the main module.
 */

export const DEFAULT_HOUR = 9;
export const DEFAULT_MINUTE = 0;

/**
 * `reference + amount` calendar months. Raw `Date.setMonth`
 * overflows — Jan 31 + 1mo becomes Mar 3 because Feb has no 31st —
 * which silently lands a reminder in the wrong month. Clamp the
 * day back to the last day of the intended month instead.
 */
export function addCalendarMonths(reference: Date, amount: number): Date {
  const next = new Date(reference);
  const targetMonth = next.getMonth() + amount;
  next.setMonth(targetMonth);
  if (next.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    next.setDate(0);
  }
  return next;
}

export function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}
