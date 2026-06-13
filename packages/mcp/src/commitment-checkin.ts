/**
 * Commitment check-ins — turn a user's detected open-loop ("I have an
 * interview tomorrow", "내일 자료 준비해야 해") into a due-windowed proactive
 * check-in the daemon delivers later ("요전에 … 하셨는데, 어떻게 됐어요?").
 *
 * This is the DELIVERY half of the open-loop story: `detectUserCommitments`
 * (agent-core) finds the commitment; `scheduleCheckins` schedules a
 * due-windowed, rate-limited, deduped check-in; `runDueCheckins` fires the due
 * ones to the USER's own channel (low-risk reply-to-user path, never a
 * third-party send), quiet-hours-aware. The check-in text is templated
 * (deterministic) — no model call, so it can't fabricate.
 *
 * Pattern adapted from OpenClaw's commitment-extraction → heartbeat delivery
 * (due-window + per-day cap) (MIT) — reimplemented for Muse, no code copied.
 * See THIRD_PARTY_NOTICES.md.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { withFileMutationQueue } from "./atomic-file-store.js";
import { isQuietHour, type QuietHourRange } from "./quiet-hours.js";

export type CheckinStatus = "scheduled" | "fired" | "cancelled";

export interface PersistedCheckin {
  readonly id: string;
  readonly userId: string;
  /** The user's open-loop commitment text (verbatim, from the detector). */
  readonly commitment: string;
  /** The templated question delivered at due time. */
  readonly question: string;
  /** ISO timestamp the check-in becomes due. */
  readonly dueAtIso: string;
  readonly createdAt: string;
  readonly status: CheckinStatus;
  readonly firedAt?: string;
  /** Normalised commitment, the dedup key (don't re-schedule the same loop). */
  readonly sourceKey: string;
}

const HANGUL = /[가-힣]/u;

/** Templated, language-matched check-in question. Deterministic — no model. */
export function buildCheckinQuestion(commitment: string): string {
  const c = commitment.trim().replace(/\s+/gu, " ");
  return HANGUL.test(c)
    ? `요전에 "${c}" 하신다고 하셨는데, 어떻게 됐어요?`
    : `Following up — you mentioned you'd "${c}". How did it go?`;
}

function normaliseKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * How many days out to fire the "how did it go?" check-in, read from a timeframe
 * the user voiced inside the commitment ("submit the forms THIS WEEK", "내일 …").
 * The follow-up must land AFTER they'd have done it, so a `this week` commitment
 * isn't nagged tomorrow. Default 1 (next day) when no timeframe is stated. Pure +
 * exported.
 */
export function followupDayOffset(commitment: string): number {
  const c = commitment.toLowerCase();
  if (/\bnext\s+week\b/u.test(c) || /다음\s*주/u.test(c)) return 8;
  if (/\bthis\s+week\b/u.test(c) || /이번\s*주/u.test(c) || /\bby\s+(mon|tue|wed|thu|fri|sat|sun)/u.test(c)) return 5;
  if (/\btomorrow\b/u.test(c) || /내일/u.test(c) || /\bnext\s+(mon|tue|wed|thu|fri|sat|sun)/u.test(c)) return 2;
  // today / tonight / later today / this afternoon / 오늘 / 이따 / no timeframe → next day.
  return 1;
}

export interface ScheduleCheckinsOptions {
  readonly now: Date;
  readonly userId: string;
  /** Local hour the next-day check-in fires. Default 10. */
  readonly slotHour?: number;
  /** Max NEW check-ins scheduled per calendar day. Default 3. */
  readonly maxPerDay?: number;
  /** Already-stored check-ins (for dedup + per-day cap). */
  readonly existing?: readonly PersistedCheckin[];
  readonly idFactory?: () => string;
}

/**
 * Schedule due-windowed check-ins from detected commitments. Each fires
 * next-day at `slotHour`. Skips a commitment already tracked (same sourceKey,
 * not cancelled). Caps NEW scheduals so today's batch + today's existing
 * scheduled never exceed `maxPerDay` (no nagging). Pure: returns the NEW
 * records to persist (does not include `existing`).
 */
export function scheduleCheckins(
  commitments: readonly string[],
  options: ScheduleCheckinsOptions
): readonly PersistedCheckin[] {
  const slotHour = Number.isFinite(options.slotHour) ? Math.max(0, Math.min(23, Math.trunc(options.slotHour as number))) : 10;
  const maxPerDay = Number.isFinite(options.maxPerDay) ? Math.max(1, Math.trunc(options.maxPerDay as number)) : 3;
  const existing = options.existing ?? [];
  const now = options.now;
  const createdAt = now.toISOString();
  const idFactory = options.idFactory ?? ((): string => `chk_${now.getTime().toString(36)}_${out.length.toString(36)}`);

  const taken = new Set(existing.filter((c) => c.status !== "cancelled").map((c) => c.sourceKey));
  const scheduledToday = existing.filter((c) => c.status === "scheduled" && c.createdAt.slice(0, 10) === createdAt.slice(0, 10)).length;

  const out: PersistedCheckin[] = [];
  let budget = Math.max(0, maxPerDay - scheduledToday);
  for (const raw of commitments) {
    if (budget <= 0) break;
    const commitment = raw.trim();
    if (commitment.length < 2) continue;
    const sourceKey = normaliseKey(commitment);
    if (taken.has(sourceKey)) continue;
    taken.add(sourceKey);
    // Fire AFTER the commitment's stated timeframe (next day by default).
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + followupDayOffset(commitment), slotHour, 0, 0, 0);
    out.push({
      commitment,
      createdAt,
      dueAtIso: due.toISOString(),
      id: idFactory(),
      question: buildCheckinQuestion(commitment),
      sourceKey,
      status: "scheduled",
      userId: options.userId
    });
    budget -= 1;
  }
  return out;
}

/** Why a check-in lookup or mutation produced no change. */
export type CheckinMutationReason = "not-found" | "ambiguous" | "already-fired" | "already-cancelled";

export interface CancelCheckinResult {
  /** The (possibly unchanged) list to persist. */
  readonly checkins: readonly PersistedCheckin[];
  /** The check-in that was cancelled, when the cancel succeeded. */
  readonly cancelled?: PersistedCheckin;
  /** Why nothing was cancelled, when `cancelled` is undefined. */
  readonly reason?: CheckinMutationReason;
  /** How many check-ins the id matched (for the ambiguous case). */
  readonly matches?: number;
}

export interface SnoozeCheckinResult {
  readonly checkins: readonly PersistedCheckin[];
  /** The check-in whose due time was bumped, when the snooze succeeded. */
  readonly snoozed?: PersistedCheckin;
  readonly reason?: CheckinMutationReason;
  readonly matches?: number;
}

/**
 * Resolve a check-in by exact id or a UNIQUE id prefix (the list shows the full
 * id; a prefix is the convenience). An ambiguous prefix never resolves to a
 * guess — it reports how many it matched so the caller can refuse. Shared by
 * cancel + snooze so both address a check-in identically.
 */
function matchCheckin(
  checkins: readonly PersistedCheckin[],
  idOrPrefix: string
): { readonly target: PersistedCheckin } | { readonly target?: undefined; readonly reason: "not-found" | "ambiguous"; readonly matches?: number } {
  const needle = idOrPrefix.trim();
  if (needle.length === 0) {
    return { reason: "not-found" };
  }
  const exact = checkins.filter((c) => c.id === needle);
  const matched = exact.length > 0 ? exact : checkins.filter((c) => c.id.startsWith(needle));
  if (matched.length === 0) {
    return { reason: "not-found" };
  }
  if (matched.length > 1) {
    return { matches: matched.length, reason: "ambiguous" };
  }
  return { target: matched[0]! };
}

/** A mutation only applies to a SCHEDULED check-in; report why otherwise. */
function mutableStatusReason(target: PersistedCheckin): CheckinMutationReason | undefined {
  if (target.status === "fired") return "already-fired";
  if (target.status === "cancelled") return "already-cancelled";
  return undefined;
}

/**
 * Cancel a SCHEDULED check-in so the daemon won't ask "how did it go?" — the
 * opt-out that makes proactivity calm: a nudge for something you already did, or
 * never wanted, must be silenceable. A fired check-in already happened and an
 * already-cancelled one is a no-op; both report why rather than silently
 * "succeeding". Pure: returns the updated list to persist.
 */
export function cancelCheckin(checkins: readonly PersistedCheckin[], idOrPrefix: string): CancelCheckinResult {
  const m = matchCheckin(checkins, idOrPrefix);
  if (!m.target) {
    return { checkins, reason: m.reason, ...(m.matches !== undefined ? { matches: m.matches } : {}) };
  }
  const statusReason = mutableStatusReason(m.target);
  if (statusReason) {
    return { checkins, reason: statusReason };
  }
  const cancelled: PersistedCheckin = { ...m.target, status: "cancelled" };
  return { cancelled, checkins: checkins.map((c) => (c.id === m.target.id ? cancelled : c)) };
}

/**
 * Defer a SCHEDULED check-in to a later moment — "ask me next week, not
 * tomorrow". The complement to cancel: a nudge that's not relevant YET shouldn't
 * have to be killed. The caller resolves `<when>` to an ISO timestamp (reusing
 * the same relative-time parser as reminders); this just bumps `dueAtIso`,
 * keeping the check-in scheduled. Same id-matching + status guards as cancel.
 */
export function snoozeCheckin(checkins: readonly PersistedCheckin[], idOrPrefix: string, newDueAtIso: string): SnoozeCheckinResult {
  const m = matchCheckin(checkins, idOrPrefix);
  if (!m.target) {
    return { checkins, reason: m.reason, ...(m.matches !== undefined ? { matches: m.matches } : {}) };
  }
  const statusReason = mutableStatusReason(m.target);
  if (statusReason) {
    return { checkins, reason: statusReason };
  }
  const snoozed: PersistedCheckin = { ...m.target, dueAtIso: newDueAtIso };
  return { snoozed, checkins: checkins.map((c) => (c.id === m.target.id ? snoozed : c)) };
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

export async function readCheckins(file: string): Promise<readonly PersistedCheckin[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PersistedCheckin =>
        Boolean(e) && typeof e === "object"
        && typeof (e as PersistedCheckin).id === "string"
        && typeof (e as PersistedCheckin).question === "string"
        && typeof (e as PersistedCheckin).dueAtIso === "string"
    );
  } catch {
    return [];
  }
}

export async function writeCheckins(file: string, checkins: readonly PersistedCheckin[]): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(checkins, null, 2)}\n`);
}

/** Append newly-scheduled check-ins to the store (in addition to existing). */
export async function appendCheckins(file: string, fresh: readonly PersistedCheckin[]): Promise<void> {
  if (fresh.length === 0) return;
  // Serialise the read→append→write on the shared per-file queue: a concurrent
  // in-process append (chat-turn hook) or the daemon's fired-status write otherwise
  // reads the same snapshot and the last write clobbers the rest — a lost check-in is
  // a proactive nudge the user never receives. (Cross-process races need a file lock.)
  await withFileMutationQueue(file, async () => {
    const existing = await readCheckins(file);
    await writeCheckins(file, [...existing, ...fresh]);
  });
}

export interface CheckinSendRegistry {
  send(providerId: string, message: { readonly destination: string; readonly text: string }): Promise<unknown>;
}

export interface RunDueCheckinsOptions {
  readonly file: string;
  readonly registry: CheckinSendRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly now?: () => Date;
  readonly maxPerTick?: number;
  /** When set and the current hour is within it, hold ALL check-ins (DND). */
  readonly quietHours?: QuietHourRange;
}

export interface RunDueCheckinsSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedCheckin[];
}

/**
 * The SCHEDULED check-ins whose due moment has arrived (`dueAtIso <= now`) — the
 * follow-ups the user is due to be asked about. Pure; soonest-due first; capped.
 * The daemon's `runDueCheckins` fires these, AND the morning brief surfaces them,
 * so a user who reads the brief (not just the daemon) still sees the follow-ups
 * they're due on. Both agree on the same SET via this one selector.
 */
export function selectDueCheckins(checkins: readonly PersistedCheckin[], nowMs: number, max = 10): readonly PersistedCheckin[] {
  const cap = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 10;
  return checkins
    .filter((c) => c.status === "scheduled" && Date.parse(c.dueAtIso) <= nowMs)
    .sort((a, b) => Date.parse(a.dueAtIso) - Date.parse(b.dueAtIso))
    .slice(0, cap);
}

/**
 * Deliver due check-ins to the user's channel. Quiet-hours holds the whole
 * tick (they fire once the window passes — the edge isn't consumed). Fires at
 * most `maxPerTick` (default 5). Marks each fired; a send failure leaves it
 * scheduled to retry next tick. Reply-to-user channel only — never a
 * third-party send.
 */
export async function runDueCheckins(options: RunDueCheckinsOptions): Promise<RunDueCheckinsSummary> {
  const now = options.now ?? ((): Date => new Date());
  const at = now();
  if (options.quietHours && isQuietHour(at.getHours(), options.quietHours)) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }
  const max = Number.isFinite(options.maxPerTick) ? Math.max(1, Math.trunc(options.maxPerTick as number)) : 5;
  const all = await readCheckins(options.file);
  const due = selectDueCheckins(all, at.getTime(), max);
  if (due.length === 0) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }
  const firedIds = new Set<string>();
  const fired: PersistedCheckin[] = [];
  const errors: string[] = [];
  for (const checkin of due) {
    try {
      await options.registry.send(options.providerId, { destination: options.destination, text: checkin.question });
      firedIds.add(checkin.id);
      fired.push({ ...checkin, firedAt: at.toISOString(), status: "fired" });
    } catch (cause) {
      errors.push(`${checkin.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (firedIds.size > 0) {
    // Re-read the FRESH store inside the queue and patch only the fired ids — NOT
    // write the stale pre-send `all`. During the multi-second send window a check-in
    // can be appended (chat hook) or cancelled; the stale write would drop the new one
    // and RESURRECT a cancelled nudge. Patch-by-id preserves every concurrent change.
    await withFileMutationQueue(options.file, async () => {
      const fresh = await readCheckins(options.file);
      const next = fresh.map((c) => (firedIds.has(c.id) ? { ...c, firedAt: at.toISOString(), status: "fired" as const } : c));
      await writeCheckins(options.file, next);
    });
  }
  return { delivered: fired.length, due: due.length, errors, fired };
}
