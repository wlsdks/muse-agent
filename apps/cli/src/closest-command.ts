/**
 * Levenshtein-based closest-match for unknown CLI
 * subcommand names. Lets `muse statu` answer with
 * "Did you mean 'status'?" instead of the commander default
 * "too many arguments" error that hid the typo.
 *
 * Pure helpers — no commander coupling, no IO — so they unit-
 * test cleanly and can be reused by other Muse surfaces that
 * need fuzzy match (e.g. `muse persona use <id>` typos in a
 * future iteration).
 */

import { levenshteinDistance } from "@muse/shared";

export { levenshteinDistance };

/**
 * Pick the closest candidate to `input` within `maxDistance` edits.
 * Ties broken by candidate order (caller supplies a stable list).
 * Returns `undefined` when nothing is close enough — a "did you
 * mean" prompt with a random-looking guess is worse than no
 * prompt at all.
 *
 * `maxDistance` defaults to a length-aware threshold: 1 edit for
 * 1-3 character inputs, 2 for 4-7, 3 for 8+. Tuned so that
 * `statu` → `status` (1 edit) and `histoy` → `history` (1 edit)
 * land, but `xyz` doesn't get pulled to any unrelated command.
 */
export function closestCommandName(
  input: string,
  candidates: readonly string[],
  maxDistance?: number
): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const cap = maxDistance ?? lengthAwareCap(trimmed.length);

  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const d = levenshteinDistance(trimmed.toLowerCase(), candidate.toLowerCase());
    if (d > cap) continue;
    if (!best || d < best.distance) best = { name: candidate, distance: d };
  }
  return best?.name;
}

function lengthAwareCap(len: number): number {
  if (len <= 3) return 1;
  if (len <= 7) return 2;
  return 3;
}
