/**
 * Evidence-gated standing-objective completion (roadmap D — the
 * grounding contract applied to `runDueObjectives`). Historically an
 * objective's `met` verdict was pure model say-so: the model read the
 * objective text and simply asserted "met". That violates the same
 * grounding contract every other surface obeys — a claim without a
 * resolved source. This module is the deterministic evidence layer: it
 * resolves a query against ONE of Muse's own local stores (never the
 * model's belief) and proves `met` only when real records exist.
 *
 * `EvidenceStore` is a closed enum on purpose — no free-text store
 * name coming out of a model response can ever reach a fetch. An
 * unrecognised store is a type error at the call site, and
 * `resolveObjectiveEvidence` fails closed (returns no evidence, never
 * throws) for a store whose reader wasn't injected.
 */

export type EvidenceStore = "actionLog" | "calendar" | "notes" | "reminders" | "tasks";

export interface EvidenceQuery {
  readonly store: EvidenceStore;
  /** Case-insensitive substring match against any keyword. */
  readonly keywords: readonly string[];
  /** How many days back (and, for calendar, forward) is relevant. Omit for unbounded. */
  readonly windowDays?: number;
  /** Minimum matching record count required to call the objective met. Omit for "at least one". */
  readonly expectedCount?: number;
}

export interface EvidenceRecord {
  /** Human-readable provenance, e.g. "task:log the workout". */
  readonly source: string;
  readonly text: string;
  readonly whenIso?: string;
}

export interface EvidenceTaskLike {
  readonly title: string;
  readonly notes?: string;
  readonly createdAt?: string;
  readonly completedAt?: string;
  readonly dueAt?: string;
}

export interface EvidenceReminderLike {
  readonly text: string;
  readonly createdAt?: string;
  readonly dueAt?: string;
  readonly firedAt?: string;
}

export interface EvidenceCalendarEventLike {
  readonly title: string;
  readonly startsAt: Date | string;
}

export interface EvidenceNoteHitLike {
  readonly id: string;
  readonly title?: string;
  readonly snippet: string;
  readonly whenIso?: string;
}

export interface EvidenceActionLogEntryLike {
  readonly what: string;
  readonly why: string;
  readonly when: string;
}

/**
 * Injected store readers. Each is optional so a call site can wire only
 * the stores it can reach (e.g. no calendar registry configured) —
 * the missing store then resolves to zero evidence rather than
 * crashing or being silently treated as satisfied.
 */
export interface ObjectiveEvidenceDeps {
  readonly readTasks?: () => Promise<readonly EvidenceTaskLike[]>;
  readonly readReminders?: () => Promise<readonly EvidenceReminderLike[]>;
  readonly listCalendarEvents?: (range: { readonly from: Date; readonly to: Date }) => Promise<readonly EvidenceCalendarEventLike[]>;
  readonly searchNotes?: (keywords: readonly string[]) => Promise<readonly EvidenceNoteHitLike[]>;
  readonly queryActionLog?: () => Promise<readonly EvidenceActionLogEntryLike[]>;
  readonly now?: () => Date;
}

const DEFAULT_CALENDAR_WINDOW_DAYS = 90;

function toIso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.toISOString();
}

async function fetchStoreRecords(query: EvidenceQuery, deps: ObjectiveEvidenceDeps): Promise<readonly EvidenceRecord[]> {
  const now = deps.now ?? (() => new Date());
  switch (query.store) {
    case "tasks": {
      if (!deps.readTasks) return [];
      const rows = await deps.readTasks();
      return rows.map((t) => ({
        source: `task:${t.title}`,
        text: `${t.title} ${t.notes ?? ""}`.trim(),
        whenIso: t.completedAt ?? t.createdAt ?? t.dueAt
      }));
    }
    case "reminders": {
      if (!deps.readReminders) return [];
      const rows = await deps.readReminders();
      return rows.map((r) => ({
        source: `reminder:${r.text}`,
        text: r.text,
        whenIso: r.firedAt ?? r.dueAt ?? r.createdAt
      }));
    }
    case "calendar": {
      if (!deps.listCalendarEvents) return [];
      const windowMs = (query.windowDays ?? DEFAULT_CALENDAR_WINDOW_DAYS) * 86_400_000;
      const nowMs = now().getTime();
      const rows = await deps.listCalendarEvents({ from: new Date(nowMs - windowMs), to: new Date(nowMs + windowMs) });
      return rows.map((e) => ({
        source: `calendar:${e.title}`,
        text: e.title,
        whenIso: toIso(e.startsAt)
      }));
    }
    case "notes": {
      if (!deps.searchNotes) return [];
      const rows = await deps.searchNotes(query.keywords);
      return rows.map((n) => ({
        source: `note:${n.title ?? n.id}`,
        text: `${n.title ?? ""} ${n.snippet}`.trim(),
        whenIso: n.whenIso
      }));
    }
    case "actionLog": {
      if (!deps.queryActionLog) return [];
      const rows = await deps.queryActionLog();
      return rows.map((a) => ({
        source: `actionLog:${a.what}`,
        text: `${a.what} ${a.why}`,
        whenIso: a.when
      }));
    }
    default:
      // Defense in depth: the TYPE is a closed union, but a value that
      // reached here from an untyped boundary (a bad `as` cast, a JSON
      // parse) must still fail closed rather than throw.
      return [];
  }
}

/**
 * Resolve a query against the ONE store it names, filtered by keyword
 * (case-insensitive substring on any keyword — an empty keyword list
 * matches everything the store returns) and by `windowDays` when set.
 * A record with no timestamp is never excluded by the window filter —
 * a store that doesn't carry a timestamp for some rows must not have
 * real evidence silently vanish because it looks "too old".
 * Never throws: a reader failure (or a missing reader) resolves to no
 * evidence, fail-closed toward "unmet" upstream.
 */
export async function resolveObjectiveEvidence(
  query: EvidenceQuery,
  deps: ObjectiveEvidenceDeps
): Promise<readonly EvidenceRecord[]> {
  let records: readonly EvidenceRecord[];
  try {
    records = await fetchStoreRecords(query, deps);
  } catch {
    return [];
  }

  const keywords = query.keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  const matchesKeywords = (text: string): boolean =>
    keywords.length === 0 || keywords.some((k) => text.toLowerCase().includes(k));

  const now = deps.now ?? (() => new Date());
  const cutoffMs = query.windowDays !== undefined ? now().getTime() - query.windowDays * 86_400_000 : undefined;
  const withinWindow = (whenIso: string | undefined): boolean => {
    if (cutoffMs === undefined || whenIso === undefined) return true;
    const whenMs = Date.parse(whenIso);
    return !Number.isFinite(whenMs) || whenMs >= cutoffMs;
  };

  return records.filter((r) => matchesKeywords(r.text) && withinWindow(r.whenIso));
}

/**
 * Deterministic completion check: `expectedCount` present ⇒ AT LEAST
 * that many resolved records; otherwise presence (>= 1) is enough. No
 * model involved — this is the code-side gate a buggy or over-eager
 * evaluator can never talk its way past.
 */
export function checkObjectiveMet(
  records: readonly EvidenceRecord[],
  query: Pick<EvidenceQuery, "expectedCount">
): { readonly met: boolean; readonly evidence: readonly EvidenceRecord[] } {
  const met = query.expectedCount !== undefined ? records.length >= query.expectedCount : records.length >= 1;
  return { evidence: records, met };
}
