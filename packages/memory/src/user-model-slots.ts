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

const DAY_MS = 24 * 60 * 60_000;
/** Half-life for inferred-preference confidence decay. 30 days → a 0.8 fades to 0.4 after a month. */
export const DEFAULT_CONFIDENCE_HALF_LIFE_DAYS = 30;
/** Default effective-confidence threshold below which an inferred slot wants re-confirmation. */
export const DEFAULT_RECONFIRM_BELOW = 0.35;

/**
 * Effective (decayed) confidence of a slot, right now.
 *
 * A slot with NO stored confidence is an ASSERTED fact (the user typed it via
 * `muse user model add` without `--confidence`) — it never decays, so it
 * returns 1. A slot WITH a stored confidence is INFERRED (the auto-extractor
 * populated it): its trust fades exponentially with age,
 * `confidence · 2^(-ageDays / halfLifeDays)`, so a behaviour Muse guessed
 * months ago stops dominating the persona unless it keeps being reinforced
 * (each fresh upsert resets `updatedAt`). Future timestamps clamp to age 0.
 */
export function effectiveConfidence(
  confidence: number | undefined,
  updatedAt: Date,
  now: Date,
  halfLifeDays: number = DEFAULT_CONFIDENCE_HALF_LIFE_DAYS
): number {
  if (confidence === undefined || !Number.isFinite(confidence)) return 1;
  const stored = Math.max(0, Math.min(1, confidence));
  const half = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_CONFIDENCE_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / DAY_MS);
  return stored * Math.pow(2, -ageDays / half);
}

export interface ReconfirmOptions {
  readonly now: Date;
  /** Effective-confidence threshold; inferred slots below it are returned. Default 0.35. */
  readonly reconfirmBelow?: number;
  readonly halfLifeDays?: number;
}

/**
 * Inferred slots (those carrying a stored confidence) whose effective
 * confidence has decayed below the re-confirm threshold — i.e. things Muse
 * once guessed about the user that have gone stale and should be confirmed or
 * dropped rather than silently trusted forever. Asserted slots (no stored
 * confidence) are never returned. Each carries its `effectiveConfidence` so a
 * surface can show "how faded". Sorted most-faded first.
 */
export function selectReconfirmableSlots(
  model: UserModel,
  options: ReconfirmOptions
): readonly { readonly slot: UserModelSlot; readonly effectiveConfidence: number }[] {
  const below = Number.isFinite(options.reconfirmBelow) ? options.reconfirmBelow! : DEFAULT_RECONFIRM_BELOW;
  const all: readonly UserModelSlot[] = [
    ...model.preferences,
    ...model.schedule,
    ...model.vetoes,
    ...model.goals
  ];
  return all
    .filter((slot) => slot.confidence !== undefined && Number.isFinite(slot.confidence))
    .map((slot) => ({ effectiveConfidence: effectiveConfidence(slot.confidence, slot.updatedAt, options.now, options.halfLifeDays), slot }))
    .filter((entry) => entry.effectiveConfidence < below)
    .sort((left, right) => left.effectiveConfidence - right.effectiveConfidence);
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
  /**
   * When set with `confidenceFloor > 0`, INFERRED slots (those carrying a
   * stored confidence) whose effective confidence — decayed by age via
   * `effectiveConfidence` — has fallen below the floor are dropped before
   * composition, so a stale guess stops polluting the persona. Asserted slots
   * (no stored confidence) and vetoes (safety constraints) are never
   * decay-dropped. Omit `now` to disable decay entirely (back-compat).
   */
  readonly now?: Date;
  readonly confidenceFloor?: number;
  readonly halfLifeDays?: number;
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

  // Decay gate: when `now` + a positive floor are supplied, an INFERRED slot
  // (carrying a stored confidence) whose effective confidence has faded below
  // the floor is dropped. Asserted slots (no confidence) always survive; the
  // caller passes vetoes through unfiltered (safety) — see below.
  const floor = options.now && Number.isFinite(options.confidenceFloor) ? Math.max(0, options.confidenceFloor!) : 0;
  const now = options.now;
  const keepByConfidence = (slot: UserModelSlot): boolean => {
    if (floor <= 0 || !now || slot.confidence === undefined) return true;
    return effectiveConfidence(slot.confidence, slot.updatedAt, now, options.halfLifeDays) >= floor;
  };

  // Vetoes lead: they are hard safety constraints ("never do X" —
  // allergies, "don't email my boss"), so the maxChars
  // right-truncation must drop soft preferences/goals before it
  // can ever silently elide a veto from the prompt. They are also never
  // decay-dropped: a stale "don't" is far safer kept than silently lost.
  for (const slot of model.vetoes.slice(0, maxPerKind)) {
    parts.push(formatVeto(slot));
    totalCount += 1;
  }
  elided += Math.max(0, model.vetoes.length - maxPerKind);

  const livePreferences = model.preferences.filter(keepByConfidence);
  for (const slot of livePreferences.slice(0, maxPerKind)) {
    parts.push(formatPreference(slot));
    totalCount += 1;
  }
  elided += Math.max(0, livePreferences.length - maxPerKind);

  const liveSchedule = model.schedule.filter(keepByConfidence);
  for (const slot of liveSchedule.slice(0, maxPerKind)) {
    parts.push(formatSchedule(slot));
    totalCount += 1;
  }
  elided += Math.max(0, liveSchedule.length - maxPerKind);

  const liveGoals = model.goals.filter(keepByConfidence);
  for (const slot of liveGoals.slice(0, maxPerKind)) {
    parts.push(formatGoal(slot));
    totalCount += 1;
  }
  elided += Math.max(0, liveGoals.length - maxPerKind);

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
