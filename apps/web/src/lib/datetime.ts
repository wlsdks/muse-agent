/// Locale-aware date-time string with a malformed-input guard. The views render
/// many `new Date(iso).toLocaleString(locale)` inline; an unparseable iso would
/// otherwise show the literal "Invalid Date". Returns "" for a bad/empty date,
/// consistent with timeUntil / formatTaskDate / dayLabel.
export function safeDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleString(locale);
}
