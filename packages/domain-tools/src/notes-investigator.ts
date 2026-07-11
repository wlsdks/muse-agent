/**
 * Production investigator for the proactive loop's seam: given
 * an imminent item, infer the likely unstated need (its topic) and
 * look it up in the user's notes, returning a one-line finding to
 * append to the unasked notice ("📎 Related notes: …").
 *
 * `search` is duck-typed (just `(query, limit) → {title}[]`) so this
 * needs no `NotesProvider` coupling and is trivially testable with a
 * real `LocalDirNotesProvider` or a fake. Fail-soft: an empty title
 * or a thrown search yields `undefined` (the proactive loop's
 * investigate seam is also fail-open — belt and suspenders, so a
 * notes hiccup can never drop a heads-up).
 */
export function createNotesInvestigator(
  search: (query: string, limit: number) => Promise<readonly { readonly title: string }[]>,
  maxHits = 3
): (item: { readonly title: string; readonly kind: string; readonly factSheet: string }) => Promise<string | undefined> {
  const cap = Math.max(1, Math.trunc(maxHits));
  return async (item) => {
    const query = item.title.trim();
    if (query.length === 0) {
      return undefined;
    }
    let hits: readonly { readonly title: string }[];
    try {
      hits = await search(query, cap);
    } catch {
      return undefined;
    }
    const titles = hits
      .map((h) => h.title.trim())
      .filter((t) => t.length > 0)
      .slice(0, cap);
    if (titles.length === 0) {
      return undefined;
    }
    return `📎 Related notes: ${titles.join(", ")}`;
  };
}
