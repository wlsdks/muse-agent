/**
 * Pick the singular or plural form of a noun for a count. Returns ONLY the noun
 * (no count) so callers keep control of formatting around it. `plural` defaults
 * to `singular + "s"`; pass it explicitly for irregular plurals ("entry"→"entries").
 */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
