/**
 * Typed user-model slots (Context Engineering step 1.c).
 *
 * The legacy `UserMemory` shape stores everything as free-text
 * `facts: Record<string, string>` + `preferences: Record<string, string>`.
 * Per the audit (Letta memory blocks + Anthropic
 * effective-context-engineering), this loses structure and makes
 * persona-snapshot composition inconsistent across runs — a "bedtime"
 * preference and a "favorite color" preference get the same shape
 * even though the agent should treat them very differently.
 *
 * This module introduces the typed alternative as a *parallel*
 * structure, not a replacement: callers that want structure use the
 * `UserModel` slots; legacy callers keep their `Record<string,string>`
 * facts. A migration path (and DB persistence) lands in subsequent
 * iters once the foundation is exercised.
 *
 * Slot taxonomy:
 *   - Preference: stable taste / style / habit ("prefers concise replies")
 *   - Schedule:   recurring time-bounded fact ("wakes at 7am KST")
 *   - Veto:       explicit "do not" rule the agent must respect ("no eggs")
 *   - Goal:       active multi-session objective ("ship Muse 1.0 by Q1")
 *
 * Each slot carries a stable `id` (so updates can replace by id, not
 * fuzzy match), a `value` (the actual content), and an optional
 * `confidence` (0..1) the auto-extract hook can populate. The
 * `updatedAt` lets dashboards show staleness.
 */

export interface UserModelSlotBase {
  /** Stable identifier — replace-by-id semantics for updates. */
  readonly id: string;
  /** Free-text value the agent will see. Keep short. */
  readonly value: string;
  /** Optional 0..1 confidence (typically populated by auto-extract). */
  readonly confidence?: number;
  /** Last update timestamp (UTC). */
  readonly updatedAt: Date;
}

export interface UserPreferenceSlot extends UserModelSlotBase {
  readonly kind: "preference";
  /**
   * Optional category for downstream filtering — e.g. `"style"`,
   * `"format"`, `"language"`. Free-form so the agent can introduce
   * new categories without a schema change.
   */
  readonly category?: string;
}

export interface UserScheduleSlot extends UserModelSlotBase {
  readonly kind: "schedule";
  /**
   * Recurrence hint as a free-text label (`"daily 07:00 KST"`,
   * `"weekdays"`, `"first Monday of month"`). Cron-grade
   * structure is the scheduler's job, not the user model — this
   * is just for the agent to factor into responses.
   */
  readonly recurrence?: string;
}

export interface UserVetoSlot extends UserModelSlotBase {
  readonly kind: "veto";
  /**
   * Optional scope tag describing where the veto applies
   * (`"food"`, `"tooling"`, `"meetings"`). Empty = global.
   */
  readonly scope?: string;
}

export interface UserGoalSlot extends UserModelSlotBase {
  readonly kind: "goal";
  /** Optional target completion date for time-bounded goals. */
  readonly dueAt?: Date;
  /** Optional progress 0..1; useful for dashboard rendering. */
  readonly progress?: number;
}

export type UserModelSlot =
  | UserPreferenceSlot
  | UserScheduleSlot
  | UserVetoSlot
  | UserGoalSlot;

export interface UserModel {
  readonly preferences: readonly UserPreferenceSlot[];
  readonly schedule: readonly UserScheduleSlot[];
  readonly vetoes: readonly UserVetoSlot[];
  readonly goals: readonly UserGoalSlot[];
}

export const EMPTY_USER_MODEL: UserModel = {
  goals: [],
  preferences: [],
  schedule: [],
  vetoes: []
};

function replaceById<T extends { readonly id: string }>(slots: readonly T[], slot: T): readonly T[] {
  return [...slots.filter((existing) => existing.id !== slot.id), slot];
}

/**
 * Upsert a typed slot into the user model — replace-by-id within the slot's
 * kind array, append if new. Pure (returns a new model). The accrual
 * primitive behind manual `muse user model add` and the auto-extractor.
 */
export function upsertUserModelSlot(model: UserModel, slot: UserModelSlot): UserModel {
  switch (slot.kind) {
    case "preference":
      return { ...model, preferences: replaceById(model.preferences, slot) };
    case "schedule":
      return { ...model, schedule: replaceById(model.schedule, slot) };
    case "veto":
      return { ...model, vetoes: replaceById(model.vetoes, slot) };
    case "goal":
      return { ...model, goals: replaceById(model.goals, slot) };
  }
}

/** Remove a slot by id from whichever kind holds it. Pure. */
export function removeUserModelSlot(model: UserModel, id: string): UserModel {
  return {
    goals: model.goals.filter((slot) => slot.id !== id),
    preferences: model.preferences.filter((slot) => slot.id !== id),
    schedule: model.schedule.filter((slot) => slot.id !== id),
    vetoes: model.vetoes.filter((slot) => slot.id !== id)
  };
}

export interface UserModelComposeOptions {
  /**
   * Per-slot-type cap. Each of the four arrays is sliced to this
   * count BEFORE composition so a chatty extractor can't bloat the
   * snapshot. Defaults to 5.
   */
  readonly maxPerKind?: number;
  /**
   * Total cap on the composed string length, enforced after
   * composition. When exceeded, the snapshot is right-truncated
   * with a `… [N slots elided]` marker. Defaults to 1_000.
   */
  readonly maxChars?: number;
}

const DEFAULT_MAX_PER_KIND = 5;
const DEFAULT_MAX_CHARS = 1_000;

/**
 * Compose a single-line `key=value; key=value; …` snapshot from a
 * `UserModel`. Plays the role `buildPersonaSnapshot` plays for the
 * legacy `Record<string,string>` facts/preferences shape, but with
 * the typed slots' richer signal preserved (kind prefix + optional
 * category / recurrence / scope / due / progress decorators).
 *
 * Output format example (vetoes lead — safety constraints first):
 *   `veto.food=no eggs; pref.style=concise; sched.morning=daily 07:00 KST; goal.muse-v1=ship by Q1 (50%)`
 *
 * Returns `undefined` when the model is empty (no slots in any
 * kind) — same contract as `buildPersonaSnapshot` so callers can
 * pass the result straight to `trimConversationMessages.personaSnapshot`.
 */
export function composeUserModelSnapshot(
  model: UserModel,
  options: UserModelComposeOptions = {}
): string | undefined {
  const maxPerKind = Math.max(0, Math.trunc(options.maxPerKind ?? DEFAULT_MAX_PER_KIND));
  const maxChars = Math.max(0, Math.trunc(options.maxChars ?? DEFAULT_MAX_CHARS));
  const parts: string[] = [];
  let totalCount = 0;
  let elided = 0;

  // Vetoes lead: they are hard safety constraints ("never do X" —
  // allergies, "don't email my boss"), so the maxChars
  // right-truncation must drop soft preferences/goals before it
  // can ever silently elide a veto from the prompt.
  for (const slot of model.vetoes.slice(0, maxPerKind)) {
    parts.push(formatVeto(slot));
    totalCount += 1;
  }
  elided += Math.max(0, model.vetoes.length - maxPerKind);

  for (const slot of model.preferences.slice(0, maxPerKind)) {
    parts.push(formatPreference(slot));
    totalCount += 1;
  }
  elided += Math.max(0, model.preferences.length - maxPerKind);

  for (const slot of model.schedule.slice(0, maxPerKind)) {
    parts.push(formatSchedule(slot));
    totalCount += 1;
  }
  elided += Math.max(0, model.schedule.length - maxPerKind);

  for (const slot of model.goals.slice(0, maxPerKind)) {
    parts.push(formatGoal(slot));
    totalCount += 1;
  }
  elided += Math.max(0, model.goals.length - maxPerKind);

  if (totalCount === 0) {
    return undefined;
  }

  const composed = parts.join("; ");
  if (maxChars <= 0 || composed.length <= maxChars) {
    return elided > 0 ? `${composed}; [${elided} slots elided]` : composed;
  }

  // Right-truncate with a tail marker that includes the elided
  // count (per-kind cap + char cap combined).
  const tailMarker = ` … [${elided + estimateTrailingDrop(composed, maxChars)} slots elided]`;
  const head = composed.slice(0, Math.max(0, maxChars - tailMarker.length));
  return `${head}${tailMarker}`;
}

function formatPreference(slot: UserPreferenceSlot): string {
  const head = slot.category ? `pref.${slot.category}.${slot.id}` : `pref.${slot.id}`;
  return `${head}=${slot.value}`;
}

function formatSchedule(slot: UserScheduleSlot): string {
  const recurrence = slot.recurrence ? ` (${slot.recurrence})` : "";
  return `sched.${slot.id}=${slot.value}${recurrence}`;
}

function formatVeto(slot: UserVetoSlot): string {
  const scope = slot.scope ? `.${slot.scope}` : "";
  return `veto${scope}.${slot.id}=${slot.value}`;
}

function formatGoal(slot: UserGoalSlot): string {
  const decorations: string[] = [];
  if (typeof slot.progress === "number" && Number.isFinite(slot.progress)) {
    decorations.push(`${Math.round(Math.max(0, Math.min(1, slot.progress)) * 100)}%`);
  }
  if (slot.dueAt instanceof Date && !Number.isNaN(slot.dueAt.getTime())) {
    decorations.push(`due ${slot.dueAt.toISOString().slice(0, 10)}`);
  }
  const tail = decorations.length > 0 ? ` (${decorations.join(", ")})` : "";
  return `goal.${slot.id}=${slot.value}${tail}`;
}

/**
 * Rough estimate of how many trailing `; `-separated parts would be
 * lost when the composed snapshot is right-truncated to `maxChars`.
 * Used only for the tail marker count — exact tracking would
 * require re-walking the parts list, which isn't worth the cost
 * for a UI annotation.
 */
function estimateTrailingDrop(composed: string, maxChars: number): number {
  if (composed.length <= maxChars) {
    return 0;
  }
  const droppedTail = composed.slice(maxChars);
  // Roughly one slot per `; ` separator in the dropped tail.
  const matches = droppedTail.match(/; /gu);
  return (matches?.length ?? 0) + 1;
}
