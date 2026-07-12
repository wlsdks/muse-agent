/**
 * Single source for the learned-user-model preference-key vocabulary: the
 * `veto:`/`goal:` slot prefixes that split `UserMemory.preferences` into
 * safety guardrails / active objectives / plain preferences, plus the three
 * fact-caution marks that flag a remembered fact as contested, provisional,
 * or stale. Previously duplicated inline across `buildMusePersona`,
 * `chat-persona-snapshot`, `select.ts`, and the status/display surfaces — a
 * drift landmine now closed by having every consumer import from here.
 */

export const VETO_PREFIX = "veto:";
export const GOAL_PREFIX = "goal:";

export function isVetoKey(key: string): boolean {
  return key.startsWith(VETO_PREFIX);
}

export function isGoalKey(key: string): boolean {
  return key.startsWith(GOAL_PREFIX);
}

export const CONTESTED_FACT_MARK = " (value has changed before — confirm it's current)";
export const PROVISIONAL_FACT_MARK = " (unconfirmed — learned once, not yet re-confirmed)";
export const STALE_FACT_MARK = " (last confirmed a while ago — may be out of date)";

export interface PreferenceSlots {
  readonly plain: readonly (readonly [string, string])[];
  readonly vetoes: readonly (readonly [string, string])[];
  readonly goals: readonly (readonly [string, string])[];
}

/**
 * Split `UserMemory.preferences` into its three slots, stripping the prefix
 * from `veto:`/`goal:` keys. Insertion order is preserved within each bucket
 * (callers that render "freshest N" rely on this matching source order).
 */
export function classifyPreferenceSlots(
  preferences: Record<string, string> | Readonly<Record<string, string>>
): PreferenceSlots {
  const plain: (readonly [string, string])[] = [];
  const vetoes: (readonly [string, string])[] = [];
  const goals: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(preferences)) {
    if (isVetoKey(key)) {
      vetoes.push([key.slice(VETO_PREFIX.length), value]);
    } else if (isGoalKey(key)) {
      goals.push([key.slice(GOAL_PREFIX.length), value]);
    } else {
      plain.push([key, value]);
    }
  }
  return { goals, plain, vetoes };
}
